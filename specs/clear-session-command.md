# 清理 Session / 清理会话 命令与语义收敛

## 问题描述

当前系统已经具备“清理 session / 清理会话”的能力，但实际实现和对外语义不够一致：

1. 现有工具名与返回文案存在混杂表述，容易让人误解为会清理所有上下文来源。
2. 实际上系统当前真正清理的是 Claude session，而不是 group memory、router backlog、文件或其他状态。
3. 用户如果通过自然语言表达“清理 session / 清理会话”，当前依赖 Agent 自己理解并调用工具，存在“口头说清理了，但实际上没调工具”的风险。
4. 当前缺少一个明确、可预测、无需模型猜测意图的命令入口。
5. 清理 active session 后，旧 run 仍可能在稍后返回 result 并回写旧 session id，导致“刚清完又像恢复了旧 session”的竞态风险。
6. Claude SDK `/clear` 的返回流里，`system/init` 可能仍携带旧 session id。如果实现过早在 `init.session_id` 上返回成功，就会把旧 session id 再次保存，导致后续继续复用旧 session。

本次需求的目标是把语义收敛为：

- 系统只支持 **清理 session**
- “清理 session”“清理会话”在产品语义上都等价于 **清理 session**
- 精确命令 `/clear` 由系统直接处理，不再依赖 Agent 判断

本次改造的非目标：

- 不清理 group memory
- 不清理 router backlog / 未消费消息
- 不清理文件、`CLAUDE.md`、skills、工具定义
- 不实现“彻底重置群状态”

## 对现有项目的影响

### 受影响的核心文件

- `src/router.ts`
  - 增加 `/clear` 精确命令的前置识别与直达执行
- `src/group-queue.ts`
  - 收敛清理语义为“只清 session”
  - 增加 session 清理后的并发保护，避免旧 run 回写旧 session id
- `src/providers/claude.ts`
  - 保留底层 `/clear` 调用，但不再把“拿到新 session id”视为唯一可信成功语义
  - 修复 `/clear` 过早采用 `init.session_id` 导致的旧 session 复用问题
- `src/tools.ts`
  - 将现有 `clear_context` 调整为以 session 为中心的工具语义
  - 评估是否新增/切换为更准确的工具名 `clear_session`
- `groups/MAIN_CLAUDE.md`
  - 明确说明“清理 session / 清理会话”都只表示清理 session
  - 明确说明用户提出该需求时，必须调用清理 session 工具后再回复
- `tests/group-queue.test.ts`
  - 增加 `/clear` 命令与清理竞态相关测试
- `tests/providers.test.ts`
  - 补充 provider clear contract 的语义测试
- `tests/router.test.ts`（若当前不存在则新增）
  - 增加 `/clear` 直达分支测试

### 受影响但不会改变语义的模块

- `src/db.ts`
  - 可能需要新增一类 group 级“session generation / clear epoch”状态，用于阻止旧 run 回写
  - 不变更 `group_memories`、`router_state` 的清理逻辑

## 实现方案

### 一、统一产品语义：只支持清理 session / 清理会话

本次实现后，系统内外统一采用以下定义：

- “清理 session” = 清除当前群对应的 Claude 会话状态，并准备新的 session
- “清理会话” = 与清理 session 同义

明确保留：

- group memory
- router backlog
- 文件系统状态
- `CLAUDE.md` / skills / tools

因此，清理完成后：

- Agent 不应再恢复到旧 session
- 但如果该群已有 group memory，后续新 session 仍会继续注入 memory
- 如果存在未消费消息，后续仍可能继续作为新的 prompt 输入给新 session

### 二、增加 `/clear` 精确命令入口

在 `src/router.ts` 的消息循环中增加前置分支：

1. 对每个群读取到新消息后，先检查是否存在“精确 `/clear` 命令消息”
2. 推荐规则：
   - 对消息内容做 `trim()`
   - 当内容 **严格等于** `/clear` 时命中
   - 仅处理文本完全匹配的场景，不支持 `/clear xxx`
3. 命中后：
   - 不进入 Agent 会话
   - 直接调用 `groupQueue.clearSession(group.folder)` 或等价 helper
   - 向当前群发送固定结果文案
   - 更新 router cursor，使该条 `/clear` 命令本身不会再次进入后续 prompt

建议固定回复文案：

```text
Session 已清理。仅清理 AI session；group memory、待处理消息和文件不会被清理。
```

这里刻意采用固定文案，不经过 Agent 生成，避免“系统动作成功但模型话术不一致”。

### 三、保留工具路径，但收紧语义

除了 `/clear` 这种系统级精确命令外，仍保留工具路径供主群或自然语言场景使用，但语义必须收紧。

建议调整为以下两种方案之一：

#### 方案 A：保留 `clear_context`，但所有文案明确写“只清 session”

优点：

- 改动最小
- 不影响现有工具调用链

缺点：

- 工具名仍然带有“context”歧义

#### 方案 B：新增 `clear_session`，并让 `clear_context` 成为兼容别名

优点：

- 语义更清晰
- 对后续维护、日志与管理更一致

缺点：

- 工具定义与提示词需要同步调整

本次实现建议采用 **方案 B**：

- 新增 `clear_session`
- `clear_context` 作为兼容 alias 保留一个迭代周期，内部复用同一 handler
- 所有对外文案、提示词、测试都以 `clear_session` 为主

### 四、修复清理后的旧 session 回写竞态

当前风险不在“是否调用了 `/clear`”，而在于：

- 清理前已有 active session 正在运行
- 清理动作关闭了该 session，并保存了新的 cleared session id
- 旧 run 可能稍后仍然返回 `result`
- 旧 run 返回时，当前实现可能再次 `saveSessionId()`，把旧 session id 写回数据库

建议在 `src/group-queue.ts` 中引入 group 级 session 版本控制，例如：

```ts
type SessionLease = {
  generation: number;
  session: AgentSession;
};
```

或等价的数据结构。

推荐实现方式：

1. 为每个 group 维护一个递增的 `sessionGeneration`
2. 启动 session 时，捕获当前 generation
3. `clearSession()` 执行时：
   - 先递增 generation
   - 再关闭当前 active session
   - 再调用 provider.clearContext()
   - 再保存新的 session id
4. 旧 run 后续消费 `events` 时：
   - 若其 generation 已不是当前值，则直接忽略其 `text` / `result`
   - 特别是禁止旧 run 再次 `saveSessionId()`

这样可以保证：

- 系统对“当前有效 session”拥有本地判定权
- 不再依赖事件返回顺序
- 清理动作完成后，旧 run 不可能污染新状态

### 五、调整成功语义与日志

当前 provider 层只要拿到新的 `session_id` 就返回成功，这个判断过于弱。

本次建议分层定义：

- provider 成功：Claude SDK `/clear` 返回了新的 `session_id`
- 系统成功：当前 group 的有效 generation 已切换，且数据库中当前 session id 已更新为新值，旧 run 无法再回写

对 provider 层再增加一条实现约束：

- 若本次 `/clear` 是基于 `resumeSessionId` 发起，则不能在 `system/init.session_id` 上提前返回
- 只有当最终 `result.session_id` 存在，且它与旧 `resumeSessionId` 不相同时，才可判定为成功
- 若最终只拿到与旧 session 相同的 id，应视为 clear 失败

日志建议补充：

- groupFolder
- previousSessionId
- newSessionId
- closedActiveSession
- generationBefore
- generationAfter
- triggeredBy
  - `slash_command`
  - `tool`

### 六、提示词与管理文案收敛

在 `groups/MAIN_CLAUDE.md` 中增加规则：

- 当用户要求“清理会话 / 清理 session”时，这些都只表示清理 session
- 执行前必须调用 `clear_session`
- 在工具成功前，不得声称“已清理”
- 回复时不得暗示 memory、待处理消息或文件也被清理

对 regular group 不要求模型直接拥有该工具；`/clear` 由系统直达处理即可。

### 七、Router 分支与现有触发逻辑的关系

`/clear` 应优先于现有 trigger 逻辑处理。

推荐顺序：

1. 读取某群新消息
2. 若最新一批消息中存在严格匹配 `/clear` 的消息，则按命令处理
3. 该命令消费完成后，更新 cursor
4. 其余消息继续沿用现有 trigger / enqueue 逻辑

这里需要特别约束一个边界：

- `/clear` 只影响 session，不应顺带丢弃其他同批次普通消息

因此建议只在以下场景先落地：

- 当本轮待处理消息中最后一条消息是 `/clear` 时，执行清理并将 cursor 推进到该命令消息

若后续要处理“同一批里 `/clear` 前后还有其他普通消息”的复杂切分，再单独扩展。

这样第一版规则更稳，不会无意吞掉业务消息。

## 实现细节建议

### 1. `GroupQueue.clearSession()` 语义

建议将返回结构扩展为：

```ts
type ClearSessionResult = {
  closedActiveSession: boolean;
  previousSessionId: string | null;
  sessionId: string;
  generation: number;
};
```

这样工具路径和 `/clear` 直达路径都能复用同一结果结构。

### 2. Router 中的 `/clear` 检测 helper

建议新增类似：

```ts
function isClearSessionCommand(message: MessageRow): boolean {
  return message.content.trim() === "/clear";
}
```

第一版不支持：

- `/clear foo`
- 大小写变体
- 混合文本如“请执行 /clear”

### 3. 工具名称兼容策略

若采用 `clear_session` 主名：

- `clear_context` 保留一段时间
- 两者调用同一 handler
- 日志与文案统一输出 “clear session”

## Todo List

### Phase 1：语义收敛

- [x] 新增本次 spec
- [x] 确定工具命名策略：`clear_session` 主名，`clear_context` 兼容 alias
- [x] 统一所有返回文案为“只清理 session”

### Phase 2：Router 直达命令

- [x] 在 `src/router.ts` 中新增 `/clear` 精确命令检测
- [x] 命中 `/clear` 时直接调用 session 清理逻辑
- [x] `/clear` 成功后发送固定系统回复
- [x] 更新 router cursor，确保 `/clear` 不进入后续 prompt

### Phase 3：清理竞态修复

- [x] 为 group 引入 session generation / lease 机制
- [x] 清理时递增 generation 并失效旧 run
- [x] 忽略过期 run 的 text/result 事件
- [x] 阻止旧 run 回写旧 session id

### Phase 4：工具与提示词收敛

- [x] 在 `src/tools.ts` 中新增或切换到 `clear_session`
- [x] 兼容保留 `clear_context` alias（如采用兼容策略）
- [x] 更新 `groups/MAIN_CLAUDE.md` 中的清理规则与工具说明

### Phase 5：测试

- [x] 增加 `/clear` 命令命中测试
- [x] 增加 `/clear` 不经过 Agent 的测试
- [x] 增加“清理后旧 run 不可回写 session id”的测试
- [x] 增加工具文案只声明清理 session 的测试
- [x] 运行相关测试并确认通过
