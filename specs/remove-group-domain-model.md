# 删除 Group 领域模型

## 问题定义

当前代码已经在主运行路径上引入了 `workspace -> chat -> session` 模型，但系统中仍长期并存另一套 `group` 领域模型：

1. 数据库里仍有 `registered_groups`、`group_memories`
2. CLI/desktop/admin/tools/runtime 中仍大量使用 `GroupService`、`RegisteredGroup`、`groupFolder`、`switchGroup()`
3. 平台信息仍有一部分挂在 `group` 上，而不是通过 `workspace_bindings` / `chat_bindings` 表达

这会导致几个长期问题：

1. 领域边界不清晰：到底是 `group` 还是 `workspace/chat` 在承载产品语义
2. 状态来源重复：memory、profile、trigger、platform routing 仍可通过 group 路径读写
3. API 泄漏旧模型：即使内部已经按 workspace/chat 运作，外部接口和类型仍继续扩散 `group` 概念
4. 后续演进困难：只要还保留兼容层，代码会持续围绕“如何兼容 group”而不是“如何做好 workspace/chat”

本次目标不是继续兼容，而是**直接删除 `group` 作为业务领域模型**。删除后的系统只保留以下实体：

- `workspace`：工作目录、长期上下文、memory、profile、runtime state 的唯一容器
- `chat`：消息入口、当前 session、触发配置的唯一承载者
- `workspace_bindings` / `chat_bindings`：平台外部标识与内部实体的唯一映射层

删除后的原则：

1. 代码中不再存在“group 是一种业务实体”的语义
2. `groupFolder` 不再作为业务主键存在，只允许 `workspaceFolder` 作为路径定位值
3. `RegisteredGroup`、`GroupService`、`switchGroup()`、`group_memories`、`registered_groups` 全部删除
4. 平台通道信息只从 binding 推导，不再依赖 `group.channel_type`

## 对现有项目的影响

### 数据库

受影响文件：

- `src/db.ts`
- 各类测试与清理脚本

影响点：

1. 删除 `registered_groups`
2. 删除 `group_memories`
3. 删除所有 `group` 相关 helper：
   - `getGroupByFolder`
   - `getGroupByJid`
   - `listGroups`
   - `registerGroup`
   - `updateGroupProfile`
   - `updateGroupMetadata`
   - `renameGroup`
   - `listGroupMemories`
   - `upsertGroupMemory`
   - `deleteGroupMemory`
   - `clearGroupMemories`
4. 清理与 group 双写、group -> workspace 同步有关的桥接逻辑
5. `scheduled_tasks` 需要改模型，不能继续使用 `group_folder` 和 `chat_jid`

### 服务层 / Runtime 层

受影响文件：

- `src/group-service.ts`
- `src/group-queue.ts`
- `src/runtime/pi-group-runtime-factory.ts`
- `src/runtime/feishu-group-adapter.ts`
- `src/kernel/group-runtime-manager.ts`
- `src/runtime/group-runtime-controller.ts`

影响点：

1. `GroupService` 整体删除
2. runtime context 不再暴露 `RegisteredGroup`
3. `switchGroup()` 删除，只保留 `switchWorkspace()` 和 `switchChat()`
4. 任何通过 `groupFolder` 解析上下文的逻辑改成通过 `workspace/chat` 解析

### CLI / Desktop / Tools

受影响文件：

- `src/cli.ts`
- `src/cli/octo-group-extension.ts`
- `src/cli/octo-cli-runtime-host.ts`
- `src/tools.ts`
- `src/desktop/api.ts`
- `src/desktop/admin-api.ts`
- `src/desktop/admin-files.ts`
- `src/desktop/server.ts`

影响点：

1. CLI 参数 `--group` 删除
2. CLI group 选择、切换、自动创建等逻辑改为 workspace/chat 语义
3. 桌面端 admin 的 “groups” API 改为 “workspaces” API
4. tool 定义从 `createGroupToolDefs(...)` 改为 workspace/chat 语义
5. admin 文件访问路径从 group folder 改为 workspace folder

### 路由 / 调度 / 通道

受影响文件：

- `src/router.ts`
- `src/task-scheduler.ts`
- `src/channels/manager.ts`

影响点：

1. router 不再保留 legacy group cursor key 或 group-based dispatch
2. scheduler 任务上下文改为 workspace/chat
3. 发送消息时，不再依赖 `channel_type` 从 `registered_groups` 查找通道

## 当前仍依赖 Group 模型的关键位置

### 1. `registered_groups` 仍是完整实体表

文件：

- `src/db.ts`

现状：

- `registered_groups` 仍包含：
  - `jid`
  - `folder`
  - `channel_type`
  - `trigger_pattern`
  - `requires_trigger`
  - `profile_key`

问题：

- 这些字段里，真正需要长期存在的语义已经分别落在：
  - `workspace_bindings`
  - `chat_bindings`
  - `workspaces.profile_key`
  - `chats.trigger_pattern`
  - `chats.requires_trigger`

因此 `registered_groups` 已经只是旧模型聚合物，应整体删除。

### 2. `GroupService` 仍负责 CLI group 的创建与选择

文件：

- `src/group-service.ts`
- `src/cli.ts`
- `src/cli/octo-group-extension.ts`

问题：

- 当前 CLI 仍通过 `GroupService.createCliGroup()` 创建“CLI group”
- 这和当前已存在的 `WorkspaceService.createCliWorkspace()` 重叠
- 等于 CLI 仍旧在用 `group` 作为顶层实体

### 3. tools 仍以 group 为主上下文

文件：

- `src/tools.ts`

现状：

- `createGroupToolDefs(groupFolder, ...)`
- memory 操作直接读写 `group_memories`
- 发送消息与 clear session 也通过 group 路径解析

问题：

- tools 是运行时最核心的边界之一，如果这里继续以 group 为语义，整个系统就不可能真正删除 group

### 4. runtime context 仍构造 `RegisteredGroup`

文件：

- `src/runtime/pi-group-runtime-factory.ts`

现状：

- 运行时仍通过 `resolveRuntimeGroupState()` 返回：
  - `group`
  - `memories`
- 当没有 legacy group 时，还会临时构造一个 workspace-backed group

问题：

- 这本质上是在延续“group 一定存在”的类型假设
- 正确方向应是 runtime context 直接返回 workspace/chat/profile/memories

### 5. CLI host / runtime manager 仍保留 `switchGroup()`

文件：

- `src/kernel/group-runtime-manager.ts`
- `src/cli/octo-cli-runtime-host.ts`

问题：

- 即使内部已经基本转成 workspace/chat，API 仍允许 group 切换
- 这会继续把旧模型暴露给上层调用方

### 6. desktop admin 仍完全是 group 视角

文件：

- `src/desktop/admin-api.ts`
- `src/desktop/admin-files.ts`

现状：

- 路由是 `listGroups/getGroup/patchGroup`
- memory API 是 group memory
- 文件 API 用 folder 但语义是 group folder

问题：

- 这会让前端和调试工具继续围绕 group 组织，而不是 workspace/chat

### 7. `group_memories` 仍是主写路径

文件：

- `src/db.ts`
- `src/tools.ts`
- `src/group-queue.ts`
- `src/desktop/admin-api.ts`

问题：

- 这意味着 memory 仍绑定在 group 上，而不是 workspace
- 即使 session 已收敛，memory 仍会让代码长期保留 group 语义

### 8. 调度任务仍持有 `group_folder` / `chat_jid`

文件：

- `src/db.ts`
- `src/task-scheduler.ts`

问题：

- 这是旧路由层结构留下来的字段设计
- 如果继续保留，会让 scheduler 长期依赖 group 模型

## 实现方案

### 总体策略

本次不做兼容层保留，直接做“删除式重构”。

核心策略：

1. 先确定最终模型
2. 再统一替换所有入口
3. 最后删除数据库和类型残留

最终模型如下：

- `workspace`
  - 唯一 folder
  - 唯一 profile
  - 唯一 memory 容器
  - 唯一 runtime state 容器
- `chat`
  - 唯一 session
  - 唯一 trigger config
  - 唯一消息绑定入口
- `workspace_bindings` / `chat_bindings`
  - 唯一平台映射层

### 方案一：数据库收口到 workspace/chat

修改文件：

- `src/db.ts`

计划：

1. 删除 `registered_groups` 表定义与所有 migration 逻辑
2. 删除 `group_memories` 表定义与所有 helper
3. 增加/调整 workspace/chat 级 helper，覆盖原 group helper 的用途
4. 修改 `scheduled_tasks` 结构：
   - `group_folder` -> `workspace_id` 或 `workspace_folder`
   - `chat_jid` -> `chat_id`
5. 清理任何 group -> workspace/chat 的同步桥接逻辑

建议方向：

- 优先使用内部主键而不是 folder/jid：

```ts
scheduled_tasks(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  ...
)
```

### 方案二：删除 GroupService，CLI 改成 WorkspaceService

修改文件：

- `src/group-service.ts`
- `src/cli.ts`
- `src/cli/octo-group-extension.ts`

计划：

1. 删除 `GroupService`
2. CLI 启动时只通过 `WorkspaceService` 解析：
   - workspace
   - chat
3. 删除 `--group` 参数
4. CLI 默认创建逻辑改用 `createCliWorkspace()`
5. CLI 扩展命令中“切 group”改成：
   - 切 workspace
   - 切 chat

### 方案三：runtime context 去 Group 化

修改文件：

- `src/runtime/pi-group-runtime-factory.ts`
- `src/kernel/group-runtime-manager.ts`
- `src/runtime/group-runtime-controller.ts`
- `src/cli/octo-cli-runtime-host.ts`

计划：

1. 删除 `RegisteredGroup` 在 runtime path 中的类型依赖
2. `PiGroupRuntimeContext` 改为：

```ts
type PiWorkspaceRuntimeContext = {
  workspace: WorkspaceRow;
  chat: ChatRow | null;
  workingDirectory: string;
  profile: ResolvedAgentProfile;
};
```

3. 删除 `switchGroup()` 与相关返回值字段
4. `GroupRuntimeManager` 可保留类名一轮实现期，但公开 API 只暴露 workspace/chat 语义
5. 后续如果需要，再单独重命名 `GroupRuntimeManager`

注：

- 本轮优先删模型和 API，不强制把所有类名一次性改名，只要求对外语义不再有 group。

### 方案四：tools 全量转为 workspace/chat 语义

修改文件：

- `src/tools.ts`

计划：

1. `createGroupToolDefs(...)` 改为 `createWorkspaceToolDefs(...)` 或等价命名
2. 消息发送目标解析从 “group” 改为 “chat binding / workspace”
3. clear session 从 `groupFolder` 改为 `chatId`
4. memory 工具全部改写到 `workspace_memories`
5. task 工具全部改写到 `workspace/chat`

注意：

- `tools.ts` 是删 group 的核心文件之一，因为这里把大量旧语义向外扩散了

### 方案五：desktop admin 改为 workspace 视角

修改文件：

- `src/desktop/admin-api.ts`
- `src/desktop/admin-files.ts`
- 对应 DTO / 测试

计划：

1. `listGroups/getGroup/patchGroup` 改为 workspace 命名
2. memory API 改为 workspace memory
3. 文件 API 参数与 DTO 改为 workspace 语义
4. 前端如果依赖旧字段，也同步替换

### 方案六：router / scheduler / channel routing 去 Group 化

修改文件：

- `src/router.ts`
- `src/task-scheduler.ts`
- `src/channels/manager.ts`

计划：

1. router 只处理 workspace/chat
2. scheduler 任务只记录 workspace/chat 主键
3. 通道选择依赖 binding 信息，不再依赖 `channel_type`

## 删除后的明确边界

本次重构完成后，代码中允许出现的概念边界如下：

### 允许保留

- `workspace`
- `chat`
- `workspaceFolder`
- `workspaceId`
- `chatId`
- `workspace_bindings`
- `chat_bindings`

### 不允许继续出现

- `RegisteredGroup`
- `GroupService`
- `registered_groups`
- `group_memories`
- `groupFolder` 作为业务语义
- `switchGroup()`
- `channel_type` 作为业务分流字段

### 特殊说明

- `groups/` 目录名是否立即改名，不作为本次必须项
- 如果某些底层文件系统 helper 仍暂时兼容 `groups/` 目录，只能作为路径兼容，不可再对应业务实体 `group`

## 风险与注意事项

1. CLI 改动面较大，需要确保历史状态文件 `CliStateStore` 不再依赖 `currentGroupFolder`
2. desktop admin API 变更会影响前端与测试，必须一并更新
3. scheduler 的数据模型变更需要同步考虑清理脚本与测试夹具
4. `GroupRuntimeManager` 类名是否重命名可后置，但公开类型和 API 不能再暴露 group
5. 不能留下“函数名删了、底层表还在”的半删除状态；数据库和 API 必须同时完成

## Todo List

- [x] 梳理并确认所有 `group` 相关数据库结构、类型、helper 的删除范围
- [x] 删除 `registered_groups` 与相关 DB helper
- [x] 删除 `group_memories` 与相关 DB helper，统一到 `workspace_memories`
- [x] 重构 `scheduled_tasks` 模型，移除 `group_folder` / `chat_jid`
- [x] 删除 `GroupService`，CLI 全量切换到 `WorkspaceService`
- [x] 删除 CLI `--group` 参数与所有 group 选择/切换逻辑
- [x] 删除 `switchGroup()` 与所有相关调用路径
- [x] 重构 runtime context，移除 `RegisteredGroup` 依赖
- [x] 重构 `tools.ts`，改成 workspace/chat 语义
- [x] 重构 desktop admin API，改成 workspace 视角
- [x] 重构 router / scheduler / channel routing，移除 group 语义
- [ ] 更新全部受影响测试
- [ ] 运行相关测试并修复失败
