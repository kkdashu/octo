# 飞书单 Workspace 收口与本地状态清理脚本

## 问题描述

当前 `workspace-chat-phase-1` 落地后，系统仍保留了大量 legacy group 兼容逻辑，导致实际行为和目标模型不一致：

1. 历史 `registered_groups` 会在启动时被迁移为多个 `workspaces`
2. `bun start` 会把这些历史 workspace 目录物化到 `workspaces/` 下
3. 飞书消息并没有稳定落到“一个 `FEISHU_APP_ID` 对应一个 workspace”的模型
4. 已存在的旧 `chat_binding` 会继续指向 legacy workspace，阻止新模型接管
5. 触发策略仍然偏向旧群模型，导致飞书 chat 在未 `@` 机器人的情况下不回消息

本次需求明确收口为更简单的模型，不再做旧数据迁移：

1. 不需要把旧 `registered_groups` / `groups/` / legacy binding 迁入新模型
2. 提供一个一次性脚本，由用户手动执行，清理本地状态
3. 清理完成后，系统从空状态重新开始注册飞书 workspace 与 chat
4. 一个 `FEISHU_APP_ID` 永远只对应一个 workspace
5. 每一个新的飞书 `chat_id` 都注册为该 workspace 下的一个 chat
6. 飞书 chat 默认直接回复，不要求 `@` 或 trigger

换句话说，本次不是“修补迁移逻辑”，而是：

1. 删除自动迁移路径
2. 删除旧本地状态
3. 用更简单的运行时注册规则重新建立 workspace/chat 数据

## 对现有项目的影响

### 一、数据库初始化与迁移逻辑

影响文件：

1. `src/db.ts`

当前问题：

1. `initDatabase()` 会调用 `migrateLegacyGroupsToWorkspaces()`
2. legacy `registered_groups` 会在每次启动时被导入 `workspaces` / `chats`
3. 这会持续制造不符合新规则的 workspace 和 chat

本次修改：

1. 停止在数据库初始化阶段执行 legacy group 自动迁移
2. 保留表结构兼容，但不再把 `registered_groups` 当作 workspace/chat 的输入源
3. 新增面向清理脚本的数据库重置能力，删除 workspace/chat 以及 legacy group 相关本地状态

### 二、飞书 workspace / chat 注册逻辑

影响文件：

1. `src/index.ts`
2. `src/workspace-service.ts`

当前问题：

1. 启动时仍混合使用 `ensureWorkspaceLegacyGroup()` 与 `ensureFeishuWorkspace()`
2. 旧 `chat_binding` 存在时，新的 app workspace 无法接管旧 chat
3. `MAIN_GROUP_CHAT_ID` 之外的 chat 默认 `requiresTrigger = true`

本次修改：

1. 移除 legacy group 兜底注册路径
2. 飞书入口只保留：
   - `FEISHU_APP_ID -> workspace`
   - `feishu chat_id -> chat`
3. 首次收到某个飞书 `chat_id` 时，在当前 app workspace 下创建 chat
4. 飞书 chat 默认 `requiresTrigger = false`
5. 若配置了 `MAIN_GROUP_CHAT_ID`，它仍然可以继续作为命名或展示上的主 chat，但不再影响“是否允许直接回复”

### 三、workspace 目录物化逻辑

影响文件：

1. `src/group-workspace.ts`
2. `src/index.ts`

当前问题：

1. 启动时会对数据库里的所有 workspace 执行 `ensureWorkspaceDirectory()`
2. 旧数据一旦还在库里，就会继续在 `workspaces/` 下生成或恢复目录
3. `migrateLegacyGroupWorkspace()` 会尝试把 `groups/<folder>` 搬进 `workspaces/<folder>`

本次修改：

1. 清理脚本负责删除 `workspaces/` 下已有工作区目录
2. 运行时只为当前有效 workspace 物化目录
3. 新逻辑不再依赖 legacy group 目录迁移来恢复 workspace

### 四、本地状态清理脚本

影响文件：

1. `scripts/reset-workspace-chat-state.ts`
2. 可能需要 `package.json` 增加执行命令

脚本职责：

1. 删除 `workspaces/` 下的 workspace 数据目录
2. 清空数据库中的新模型与旧模型残留状态
3. 明确清空以下表：
   - `workspaces`
   - `workspace_bindings`
   - `chats`
   - `chat_bindings`
   - `workspace_runtime_state`
   - `runs`
   - `run_events`
   - `registered_groups`
   - `sessions`
   - `group_memories`
   - `messages`
   - `router_state`
4. 脚本是手动执行的一次性工具，不在 `bun start` 中自动触发

清理后预期状态：

1. 本地不再保留任何旧 workspace/chat/group 数据
2. 启动服务后，只有当前 `FEISHU_APP_ID` 会创建一个 workspace
3. 后续飞书消息会按 chat 动态注册到这个 workspace 下

## 实现方案

### 一、移除 legacy 自动迁移入口

在 `src/db.ts` 中调整数据库初始化流程：

1. 保留表创建逻辑
2. 保留必要的字段补齐 migration
3. 移除 `migrateLegacyGroupsToWorkspaces(db)` 的自动调用

目标效果：

1. 启动服务时不再从 `registered_groups` 自动生成 workspace/chat
2. `registered_groups` 只作为可被清理的历史表，不再驱动运行时行为

示意：

```ts
export function initDatabase(dbPath: string): Database {
  // create tables...
  migrateRegisteredGroupsProfileKey(db);
  migrateSessionsSessionRef(db);
  migrateWorkspacesProfileKey(db);
  migrateChatsTriggerConfig(db);
  // 不再调用 migrateLegacyGroupsToWorkspaces(db)
  return db;
}
```

### 二、收敛飞书注册模型

在 `src/index.ts` 中删除 legacy 混合逻辑，改成单一入口：

1. 启动时只确保当前 `FEISHU_APP_ID` 对应的 workspace 存在
2. 收到飞书消息后：
   - 先插入消息
   - 再确保该消息所属 `chat_id` 在当前 workspace 下有 chat 记录

核心规则：

1. `workspace = FEISHU_APP_ID`
2. `chat = 飞书 chat_id`
3. `requiresTrigger = false`

示意：

```ts
function ensureFeishuRuntimeWorkspace(): WorkspaceRow {
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (!appId) {
    throw new Error("FEISHU_APP_ID is required");
  }

  return workspaceService.ensureFeishuWorkspace(appId, {
    profileKey: getDefaultProfileKey(),
  });
}

function ensureFeishuChatBinding(chatId: string) {
  const workspace = ensureFeishuRuntimeWorkspace();
  workspaceService.ensureFeishuChat(workspace.id, chatId, {
    title: `Chat ${chatId}`,
    requiresTrigger: false,
  });
}
```

### 三、调整 `WorkspaceService` 的飞书 chat 默认行为

在 `src/workspace-service.ts` 中收敛 `ensureFeishuChat()`：

1. 默认 `requiresTrigger = false`
2. 已存在 binding 时直接返回
3. 不再假设默认应该要求触发

示意：

```ts
return this.createChat(workspaceId, {
  title: options?.title?.trim() || `Auto (${externalChatId})`,
  requiresTrigger: options?.requiresTrigger ?? false,
  triggerPattern: options?.triggerPattern,
  externalBinding: {
    platform: "feishu",
    externalChatId,
  },
});
```

### 四、提供一次性清理脚本

新增 `scripts/reset-workspace-chat-state.ts`，职责分为两部分。

第一部分，清理目录：

1. 扫描 `<root>/workspaces/`
2. 删除所有 workspace 子目录
3. 保留目录根本身

第二部分，清理数据库：

1. 打开 `store/messages.db`
2. 在事务中按依赖顺序删除数据
3. 清理新模型表和 legacy 表

建议删除顺序：

```text
run_events
runs
workspace_runtime_state
chat_bindings
chats
workspace_bindings
workspace_memories
workspaces
scheduled_tasks
sessions
group_memories
registered_groups
messages
router_state
```

需要注意：

1. `workspace_memories` 也应清空，否则会保留旧 workspace 记忆
2. `scheduled_tasks` 也应清空，否则可能继续引用已删除的 legacy group/workspace
3. 删除目录时必须限制范围在 `<root>/workspaces`
4. 脚本默认直接执行清理，不引入交互式确认

### 五、测试与验证

需要补充或修改的测试方向：

1. 数据库初始化后不再自动从 `registered_groups` 生成 workspace/chat
2. 飞书收到新 `chat_id` 时，只在当前 `FEISHU_APP_ID` workspace 下创建 chat
3. 新建飞书 chat 默认 `requiresTrigger = false`
4. 清理脚本执行后：
   - `workspaces/` 子目录被删除
   - 相关数据表被清空
5. 清理后重新启动并接收第一条飞书消息时：
   - 创建一个 workspace
   - 创建对应 chat
   - router 能直接触发回复

## Todo List

- [x] 修改 `src/db.ts`，移除 `migrateLegacyGroupsToWorkspaces()` 的启动期自动执行
- [x] 修改 `src/index.ts`，移除 legacy group 混合注册逻辑，统一为 `FEISHU_APP_ID -> workspace`
- [x] 修改 `src/workspace-service.ts`，让飞书 chat 默认 `requiresTrigger = false`
- [x] 评估并收敛 `src/group-workspace.ts` 中对 legacy group 目录迁移的依赖，确保新流程不依赖旧目录
- [x] 新增 `scripts/reset-workspace-chat-state.ts`，实现一次性本地状态清理
- [x] 如有必要，更新 `package.json`，增加脚本执行入口
- [x] 新增或更新测试，覆盖数据库初始化、飞书 chat 注册、默认直接回复、清理脚本
- [x] 运行测试并验证清理后首条飞书消息可以直接触发回复
