# Inbound Message 与 Turn Request 一期实现方案

## 问题定义

当前代码里，飞书、CLI、desktop、scheduler 四种入口分别以不同方式驱动 runtime：

1. 飞书消息先写入 `messages` 表，再由 `router.ts` 轮询并直接触发 runtime
2. CLI 直接调用 `GroupRuntimeManager` / `OctoCliRuntimeHost` 驱动本地 runtime
3. desktop sidecar 直接调用 `GroupRuntimeManager.prompt()` 驱动本地 runtime
4. scheduler 直接把 prompt 交给 runtime 控制器

这会带来几类问题：

1. `messages` 同时承担“外部原始消息”和“待执行 AI 请求”的语义，模型混乱
2. `runs / run_events` 虽然已经存在，但谁来创建 run 并没有统一入口
3. 飞书、CLI、desktop、scheduler 的错误处理、审计链路、运行状态记录都不一致
4. 后续二期要做 `octo-server + clients` 时，没有统一的执行入口可以直接迁移

本次一期的目标不是做单 server 架构，而是先把**数据模型和执行入口**统一下来：

- 外部通道原始消息进入 `inbound_messages`
- 所有 AI 执行都必须先创建 `turn_requests`
- `runs / run_events` 统一关联到 `turn_requests`
- `bun start`、`bun cli`、`desktop sidecar` 仍然允许多进程直连同一个 SQLite 数据库并各自执行 runtime

## 对现有项目的影响

本次改动会影响以下模块：

- 数据库初始化与数据访问层：`src/db.ts`
- 飞书入口与轮询分发：`src/index.ts`、`src/router.ts`
- 飞书执行控制器：`src/runtime/feishu-group-adapter.ts`
- 通用 runtime 管理器：`src/kernel/group-runtime-manager.ts`
- CLI 运行入口：`src/cli.ts`、`src/cli/octo-cli-runtime-host.ts`
- desktop sidecar 与 API：`src/desktop/main.ts`、`src/desktop/api.ts`
- scheduler：`src/task-scheduler.ts`
- 相关测试：`tests/router.test.ts`、`tests/feishu-group-adapter.test.ts`、`tests/group-runtime-manager.test.ts`、`tests/desktop-api.test.ts`、`tests/octo-cli-runtime-host.test.ts`、`tests/reset-workspace-chat-state.test.ts`

本次不会做的事情：

1. 不实现二期的 `octo-server + feishu/cli/desktop client` 进程解耦
2. 不引入 RPC、WebSocket、HTTP/SSE 的跨进程协议
3. 不实现 `outbound_messages`
4. 不实现 turn request 跨实例接管、lease、心跳、重新分配
5. 不要求 CLI / desktop 通过一个单独 server 才能工作

## 一期目标边界

### 1. 进程边界

一期保持当前过渡架构：

- `bun start` 直接连接 `store/messages.db`，负责 Feishu ingress、inbound dispatcher、scheduler，并执行自己创建的 turn request
- `bun cli` 直接连接 `store/messages.db`，创建并执行自己的 turn request
- `desktop sidecar` 直接连接 `store/messages.db`，创建并执行自己的 turn request

也就是说，一期允许多个 runtime 进程共存，但必须统一到同一套表结构与状态流。

### 2. 统一入口边界

一期之后，所有会触发 AI 执行的入口都要先落到 `turn_requests`：

- 飞书：`Feishu event -> inbound_messages -> inbound dispatcher -> turn_requests -> runs / run_events`
- CLI：`CLI input -> turn_requests -> runs / run_events`
- desktop：`desktop input -> turn_requests -> runs / run_events`
- scheduler：`scheduler tick -> turn_requests -> runs / run_events`

### 3. 运行记录边界

`runs / run_events` 保留并扩展，不再允许任何入口绕开 `turn_requests` 直接创建 run。

## 实现方案

### 一、数据库与数据模型

#### 1. 新增 `inbound_messages`

用途：

- 存放外部通道的原始入站消息
- 一期先由飞书写入
- 后续可扩展到其它平台

建议字段：

```sql
CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  workspace_id TEXT,
  chat_id TEXT,
  external_message_id TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  external_thread_id TEXT,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  sender_type TEXT NOT NULL DEFAULT 'user',
  message_type TEXT NOT NULL DEFAULT 'text',
  content_text TEXT NOT NULL DEFAULT '',
  raw_payload TEXT NOT NULL,
  message_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL,
  UNIQUE(platform, dedupe_key)
)
```

实现要求：

- `raw_payload` 存调试和审计信息
- `dedupe_key` 一期先直接复用平台消息 id
- 飞书入库时就尽量解析出 `workspace_id` 和 `chat_id`

#### 2. 新增 `inbound_dispatcher_cursors`

用途：

- 取代 `router_state` 里 `last_timestamp:*` 这类半结构化 cursor
- 记录某个 dispatcher 对某个 chat 消费到哪里

建议字段：

```sql
CREATE TABLE IF NOT EXISTS inbound_dispatcher_cursors (
  consumer TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_inbound_message_id TEXT,
  last_message_timestamp TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consumer, chat_id)
)
```

一期只需要一个 consumer：

- `default_inbound_dispatcher`

#### 3. 新增 `turn_requests`

用途：

- 统一 AI 执行入口

建议字段：

```sql
CREATE TABLE IF NOT EXISTS turn_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  input_mode TEXT NOT NULL DEFAULT 'prompt',
  request_text TEXT NOT NULL,
  request_payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
)
```

字段说明：

- `source_type`
  - `channel_inbound`
  - `cli`
  - `desktop`
  - `scheduled_task`
  - `system`
- `source_ref`
  - 飞书 dispatcher 里记录 inbound message id 列表或 batch id
  - CLI / desktop 记录本地 request id
  - scheduler 记录 task id
- `input_mode`
  - `prompt`
  - `follow_up`
  - `steer`
- `request_payload`
  - 存放将来可扩展的结构化字段
- `status`
  - `queued`
  - `running`
  - `completed`
  - `failed`
  - `cancelled`

#### 4. 扩展 `runs`

给 `runs` 增加：

```sql
ALTER TABLE runs ADD COLUMN turn_request_id TEXT
```

要求：

- 每个 run 都必须带 `turn_request_id`
- 不再允许“凭空 startRun”

#### 5. 旧表处理策略

- `messages` 一期保留兼容，但飞书新链路不再写入
- `router_state` 一期不再新增使用，清理脚本需要一起清理

### 二、数据访问层 `src/db.ts`

新增数据类型和函数：

- `InboundMessageRow`
- `InboundDispatcherCursorRow`
- `TurnRequestRow`
- `insertInboundMessage()`
- `listPendingInboundMessagesForChat()`
- `getInboundDispatcherCursor()`
- `upsertInboundDispatcherCursor()`
- `createTurnRequest()`
- `getTurnRequestById()`
- `listQueuedTurnRequests()` 或 `listQueuedTurnRequestsByChat()`
- `updateTurnRequest()`

修改已有函数：

- `createRun()` 增加 `turnRequestId`
- `RunRow` 增加 `turn_request_id`

### 三、飞书链路改造

#### 1. `src/index.ts`

当前逻辑：

- Feishu `onMessage` 直接 `insertMessage()`
- 再由 `startMessageLoop()` 从 `messages` 表轮询

一期改成：

1. `ensureFeishuWorkspace()` / `ensureFeishuChat()`
2. `insertInboundMessage()`
3. 启动 `startInboundDispatcherLoop()`

这里不再往 `messages` 表写飞书消息。

#### 2. `src/router.ts`

当前 `router.ts` 本质上是飞书消息轮询器，需要改造成一期的 inbound dispatcher：

- 输入：`inbound_messages`
- 行为：
  - 按 chat 读取 cursor 之后的新消息
  - 判断 `/clear`
  - 根据 trigger 策略决定是否创建 `turn_request`
  - 聚合一批消息为一次 turn request 的 `request_text`
  - 成功后推进 `inbound_dispatcher_cursors`

保留的规则：

- `/clear` 仍然直接调用清理 session，并回飞书系统消息
- 若执行失败且错误无法通知飞书，则不推进 cursor

删除的旧行为：

- 不再直接 `groupQueue.enqueue(chatId, prompt)`
- 不再使用 `router_state` 的 `last_timestamp:*`

### 四、执行层统一

#### 1. `src/runtime/feishu-group-adapter.ts`

当前接口是：

- `enqueue(chatId, initialPrompt)`

一期改成：

- `executeTurnRequest(turnRequestId)` 或 `executeTurnRequest(turnRequest)`

行为要求：

1. 读取 `turn_request`
2. 将 `turn_request.status` 更新为 `running`
3. 创建 `run(turn_request_id=...)`
4. 执行 runtime
5. 记录 `run_events`
6. 成功时更新：
   - `turn_request.status = completed`
   - `run.status = completed`
7. 失败时更新：
   - `turn_request.status = failed`
   - `run.status = failed`
   - 若是飞书请求，尽量把错误消息发回飞书

#### 2. `src/kernel/group-runtime-manager.ts`

当前 `prompt(chatId, input)` 内部会直接 `startRun()`。

一期改成两层：

1. 面向入口层：
   - `createPromptTurnRequest(chatId, input, sourceType, sourceRef?)`
2. 面向执行层：
   - `executeTurnRequest(turnRequestId)` 或内部复用 `runTurnRequest()`

重点约束：

- `prompt()` 不再直接创建 run
- `startRun()` 只能被 turn request 执行路径调用
- `newSession()` / `abort()` 暂不进入 `turn_requests`，继续保留为直接控制操作

### 五、CLI 改造

CLI 一期必须也走 `turn_requests`。

当前问题：

- `InteractiveMode` 直接绑定 `OctoCliRuntimeHost`
- `OctoCliRuntimeHost` 目前会把调用直接转发给本地 runtime / manager

一期改造方案：

1. `OctoCliRuntimeHost` 拦截用户发起的 `prompt` / `follow_up` / `steer`
2. 先创建 `turn_request(source_type='cli')`
3. 由当前 CLI 进程立即执行这条 request
4. 执行完成后继续把 runtime 状态同步回 `InteractiveMode`

这里不做的事：

- 不实现“CLI A 写请求，CLI B 接管执行”
- 不实现“CLI 崩溃后其它实例接管 turn request”

### 六、desktop 改造

当前 desktop API 的 `prompt` 路由直接调用 `manager.prompt(chatId, input)`。

一期改造方案：

1. `desktop/api.ts`
   - `prompt` 路由改为先创建 `turn_request(source_type='desktop')`
   - 再由当前 sidecar 立即执行该 request
2. SSE `getEvents` 继续基于 snapshot + runtime event 工作
3. `newSession` / `abort` 暂不进入 `turn_requests`

### 七、scheduler 改造

当前 scheduler 直接调 runtime 控制器。

一期改造方案：

1. due task 到点后先创建 `turn_request(source_type='scheduled_task', source_ref=task.id)`
2. 再由当前 `bun start` 进程执行该 request

### 八、兼容与迁移

#### 1. 清理脚本

本轮已有本地状态清理脚本，需要同步扩展为清理：

- `inbound_messages`
- `inbound_dispatcher_cursors`
- `turn_requests`
- `runs`
- `run_events`
- `router_state`

#### 2. 老代码兼容策略

- 保留 `messages` 表和相关函数，避免一次性破坏过多测试
- 但飞书主链路从本次开始不再使用 `messages`
- 旧 `router` 测试要改写为 dispatcher 语义测试

## 关键实现决策

### 1. 一期不做 claim / lease

原因：

- 一期仍是多进程直连 DB 的过渡态
- 但每个入口创建的 request 都由当前进程立即执行，不需要队列抢占
- 这样可以避免把“统一入口”和“跨进程调度”绑在一起

### 2. 一期的 turn request 是“记录 + 本地立即执行”

也就是说，一期先统一语义与审计链路，不统一调度器。

### 3. `/clear` 不是 turn request

`/clear` 是控制命令，不是一次 AI turn。

一期保持：

- dispatcher 识别 `/clear`
- 直接清理 session
- 直接发送系统回复

### 4. `newSession()` / `abort()` 暂不进入 turn_requests

原因：

- 这两个操作更像控制命令，而不是“给 AI 的一次 turn”
- 一期先把最核心的 prompt / follow_up / steer / scheduled prompt 收口

## 验证方案

### 1. 单元测试

需要覆盖：

- 飞书消息写入 `inbound_messages`
- dispatcher 从 `inbound_messages` 创建 `turn_requests`
- dispatcher 对 `/clear` 的特殊路径
- `GroupRuntimeManager` 通过 `turn_requests` 创建 run
- `FeishuGroupAdapter` 通过 `turn_request` 执行并写 `runs / run_events`
- desktop `prompt` 改为 `turn_request`
- CLI host 通过 `turn_request` 驱动交互输入
- scheduler 创建 `turn_request`

### 2. 手工验证

- `bun start` 收到飞书消息后能正常回复
- `bun cli` 仍可正常发起 prompt、follow_up、steer
- desktop sidecar 的 prompt 仍可正常返回
- `/clear` 行为保持不变
- 本地清理脚本能清空新增表

## Todo List

- [x] 更新 `src/db.ts`：新增 `inbound_messages`、`inbound_dispatcher_cursors`、`turn_requests` 及对应数据访问接口
- [x] 更新 `src/db.ts`：为 `runs` 增加 `turn_request_id` 并修改 `createRun()`
- [x] 重构 `src/index.ts`：飞书入口改为写 `inbound_messages`
- [x] 重构 `src/router.ts`：改为 inbound dispatcher，只负责生成 `turn_requests` 与处理 `/clear`
- [x] 重构 `src/runtime/feishu-group-adapter.ts`：改为执行 `turn_request`
- [x] 重构 `src/kernel/group-runtime-manager.ts`：新增 turn request 创建与执行路径，`prompt()` 不再直接起 run
- [x] 重构 `src/cli/octo-cli-runtime-host.ts` 与 `src/cli.ts`：CLI 输入统一先落 `turn_requests`
- [x] 重构 `src/desktop/api.ts` 与 `src/desktop/main.ts`：desktop prompt 统一先落 `turn_requests`
- [x] 重构 `src/task-scheduler.ts`：scheduler 统一先落 `turn_requests`
- [x] 更新本地状态清理脚本，纳入新增表
- [x] 更新并补充测试
- [x] 运行相关测试并完成手工验证
