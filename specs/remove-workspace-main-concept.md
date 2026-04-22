# 移除 workspace 主/非主概念

## 问题描述

当前系统仍然保留了 `workspace.is_main` 这一层“主 workspace”语义，但它已经和实际行为严重脱节：

1. 消息是否直回由 chat 的 `requires_trigger` 控制，而不是 `is_main`
2. `is_main` 主要只剩模板选择、工具权限、部分桌面接口展示用途
3. 这导致模板、数据库、桌面接口和运行时权限模型都混入了过时的“主/非主”概念

本次要彻底移除这层概念，让所有 workspace 都是同一等级：

1. 不再区分主 workspace / 非主 workspace
2. agent tool 不再内置跨 workspace 管理能力
3. workspace 初始化只使用一个统一的 `AGENTS.md` 模板
4. trigger 继续保留在 chat 级，并通过 admin API 控制
5. `/clear` 保留为唯一的聊天内管理命令

## 对现有项目的影响

本次改造会影响以下部分：

1. 数据库
   - `src/db.ts`
   - 删除 `workspaces.is_main`
   - 调整 `WorkspaceRow`、`createWorkspace()`、`updateWorkspace()`、`listWorkspaces()` 等 helper
   - 为已有数据库增加移除 `is_main` 列的迁移逻辑

2. workspace 初始化
   - `src/group-workspace.ts`
   - 删除 `MAIN_AGENTS.md` / `GROUP_AGENTS.md` 双模板逻辑
   - 改为单一模板

3. workspace 服务
   - `src/workspace-service.ts`
   - 删除 `CreateWorkspaceOptions.isMain`
   - 不再在创建 CLI / Feishu workspace 时推导主 workspace

4. 运行时与工具
   - `src/tools.ts`
   - `src/runtime/pi-group-runtime-factory.ts`
   - `src/providers/types.ts`
   - 删除 `isMain` 上下文与 main-only tool
   - 普通工具仅允许作用于当前 workspace / 当前 chat

5. 桌面接口与摘要类型
   - `src/kernel/types.ts`
   - `src/kernel/group-runtime-manager.ts`
   - `src/desktop/api.ts`
   - `src/desktop/admin-api.ts`
   - `src/desktop/admin-types.ts`
   - `src/cli/group-selector.ts`
   - 删除 `isMain` 返回字段与 `[main]` 展示

6. 启动链路
   - `src/index.ts`
   - 删除 `MAIN_GROUP_CHAT_ID` 驱动的 “Main” 标题语义

7. 模板与现存 workspace 指令
   - 删除 `groups/MAIN_AGENTS.md`
   - 删除 `groups/GROUP_AGENTS.md`
   - 新建统一模板
   - 更新仓库内现存的 `workspaces/*/AGENTS.md`，去掉旧的主 workspace 语义

8. 测试
   - 更新所有依赖 `is_main` / `isMain` 的测试 fixture 与断言
   - 更新依赖双模板或旧标题语义的测试

## 实现方案

### 一、数据库层彻底移除 `is_main`

`workspaces` 表改为：

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  profile_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

迁移策略：

1. 如果旧表中存在 `is_main` 列，则通过重建表移除该列
2. 迁移时保留其他字段值不变
3. `listWorkspaces()` 不再按 `is_main DESC` 排序，改为只按 `name ASC`

### 二、workspace 初始化改为单模板

`src/group-workspace.ts` 改为只读取单一模板文件，例如：

```text
groups/WORKSPACE_AGENTS.md
```

`setupWorkspaceDirectory()` 与 `ensureAgentsMd()` 不再接收 `isMain` 参数。

### 三、删除 workspace 服务中的主 workspace 推导

`src/workspace-service.ts` 中：

1. `CreateWorkspaceOptions` 去掉 `isMain`
2. `createCliWorkspace()` 不再判断“第一个 workspace 是主 workspace”
3. `ensureFeishuWorkspace()` 不再根据数量设置 `isMain`
4. `ensureWorkspaceDirectory()` 调用统一模板初始化

### 四、移除 agent tool 中的主 workspace 管理能力

`src/tools.ts` 中：

1. 删除 `WorkspaceToolContext.isMain`
2. `send_message` / `send_image` 只允许当前 chat，不再允许跨 chat
3. workspace memory 相关工具只允许当前 workspace，不再支持 `targetWorkspaceFolder`
4. 删除 main-only tools：
   - `list_workspaces`
   - `refresh_chats`
   - `schedule_workspace_task`
   - `list_profiles`
   - `switch_profile`
   - `clear_session`

`/clear` 命令继续保留在 `src/router.ts`

### 五、更新桌面接口与摘要类型

删除以下字段：

1. `RuntimeSummary.isMain`
2. Desktop API `listWorkspaces()` 返回中的 `isMain`
3. Desktop Admin API `DesktopAdminWorkspaceDto.isMain`
4. CLI workspace 选择器中的 `[main]`

### 六、移除启动链路中的 main chat 标题语义

`src/index.ts` 中：

1. 删除 `MAIN_GROUP_CHAT_ID` 对 chat 标题 `"Main"` 的特殊处理
2. Feishu chat 一律使用统一标题逻辑
3. `requiresTrigger` 逻辑保持现状，不和 workspace 身份绑定

### 七、模板和现存 AGENTS 文案清理

统一模板中不再出现：

1. main admin workspace
2. elevated privileges
3. registered_groups
4. groups/main
5. cross-group 管理工具

同时更新仓库内已存在的 `workspaces/*/AGENTS.md`，避免继续保留旧语义。

### 八、admin API 边界

本轮只保留当前 admin API 已有能力：

1. 列出 workspace
2. 查看和修改 workspace 基本配置
3. 修改 trigger / profile
4. 管理 workspace memory
5. 管理 workspace 文件

对于原 main-only tool 中 admin 侧暂未具备的能力，本轮先不补新接口。

## Todo List

- [x] 新增本规格文档
- [x] 修改 `src/db.ts`，删除 `is_main` 字段与相关 helper 参数/返回
- [x] 修改 `src/group-workspace.ts`，改为单一 `AGENTS` 模板
- [x] 修改 `src/workspace-service.ts`，删除主 workspace 推导逻辑
- [x] 修改 `src/tools.ts`、`src/runtime/pi-group-runtime-factory.ts`、`src/providers/types.ts`，移除 main-only tool 与 `isMain` 上下文
- [x] 修改 `src/kernel/types.ts`、`src/kernel/group-runtime-manager.ts`、`src/desktop/api.ts`、`src/desktop/admin-api.ts`、`src/desktop/admin-types.ts`、`src/cli/group-selector.ts`，移除 `isMain` 接口字段与展示
- [x] 修改 `src/index.ts`，删除 `MAIN_GROUP_CHAT_ID` 的 “Main” 标题逻辑
- [x] 合并模板文件，新增统一模板并删除旧双模板
- [x] 更新仓库中现存的 `workspaces/*/AGENTS.md`
- [x] 更新受影响测试
- [x] 运行相关测试并修正失败项
