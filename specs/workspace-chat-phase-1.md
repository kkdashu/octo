# Workspace / Chat 一期规格

## 问题描述

当前 `octo` 的主状态单位仍然是 `group`。这会把三类本来应该拆开的概念混在一起：

1. 外部入口对象
   - 例如飞书群、CLI 入口、desktop 入口
2. 工作区主体
   - 当前对应 `groups/<folder>/`
   - 持有 `AGENTS.md`、`.pi/skills`、`.pi/sessions`
3. 对话窗口
   - 当前没有一等对象，只能通过同一个 group 的单条 Pi session 延续上下文

这种设计的问题不是命名不优雅，而是直接限制了产品能力：

1. 一个工作区无法同时承载多个 chat
2. 飞书 App、desktop、CLI 都无法围绕同一个工作区开多个独立对话
3. 运行态只能按 `groupFolder` 维度持久化，无法做到：
   - chat 级恢复
   - chat 级取消
   - chat 级可观测
4. branch 语义无法落地，因为当前没有“讨论窗口”和“工作线”之间的稳定关系

本次一期目标不是一次性引入 `git worktree`、多 run 并发和复杂线程路由，而是先把核心模型拆对：

```text
Workspace = 稳定工作区主体
Chat      = Workspace 内的讨论窗口
Branch    = Chat 当前绑定的逻辑工作线
Run       = Chat 上的一次执行实例
```

一期明确采用以下产品定义：

1. `Workspace` 才是稳定工作区主体
2. `Chat` 默认是讨论窗口，而不是任务卡片
3. 每个 `Chat` 都必须有一个 `active_branch`
4. 新建 `Chat` 时默认绑定 `workspace.default_branch`
5. 多个 `Chat` 可以共享同一个 branch
6. `switch branch` 必须是显式确认动作
7. 一期不做 `worktree`
8. 一期同一个 `Workspace` 一次只允许一个 active run

本次还要明确一个核心判断：

1. `git` 不只是代码仓库，也可以作为任务仓库
2. `Workspace` 的共享状态不应主要依赖 memory，而应主要依赖共享 workspace / repo 中的显式工件
3. `memory` 只保留少量稳定规则
4. `Chat` 私有状态主要体现在聊天历史与 `session_ref`，而不是一期新增一套复杂的 chat memory 体系

换句话说，一期的落点不是“把群重命名成 Workspace”，而是把整个系统从：

```text
group = 外部会话 + 工作区 + 对话
```

重构为：

```text
Workspace = 工作区主体
Chat      = 讨论窗口
Run       = 执行实例
Binding   = 外部入口和内部对象的映射
```

## 对现有项目的影响

### 一、顶层领域模型从 Group 改为 Workspace

当前代码中，大量核心状态都按 `groupFolder` 挂载：

1. 数据库中的 `registered_groups`
2. `src/group-queue.ts` 的队列锁、活跃会话、session generation
3. `src/kernel/group-runtime-manager.ts` 的 snapshot、事件流、abort、新 session
4. `src/desktop/api.ts` 的 `/groups/:folder/*` 路由
5. `src/router.ts` 的消息聚合与触发

这意味着一期不能只加几张表，而是要承认现有 `group` 模型已经不够用。

新的领域边界应为：

```text
Workspace
  ├─ workspace folder
  ├─ AGENTS.md
  ├─ .pi/skills
  ├─ .pi/sessions
  ├─ default_branch
  ├─ workspace memory
  ├─ external bindings
  └─ chats[]

Chat
  ├─ workspace_id
  ├─ title
  ├─ active_branch
  ├─ session_ref
  ├─ messages[]
  └─ runs[]
```

### 二、文件系统从 “每个 group 一个目录” 改为 “每个 workspace 一个目录”

当前 README 中的工作区约定是：

```text
groups/<folder>/
  AGENTS.md
  .pi/
    skills/
    sessions/
```

一期应改为：

```text
workspaces/<folder>/
  AGENTS.md
  .pi/
    skills/
    sessions/
```

每个 `Workspace` 目录仍然复用 Pi-native 约定：

1. `AGENTS.md`
2. `.pi/skills/`
3. `.pi/sessions/`

但语义已经改变：

1. 目录属于 `Workspace`
2. 目录不再直接对应某个飞书群
3. 目录中的 `.pi/sessions/*` 将被多个 `Chat` 引用
4. 目录本身是共享 workspace / repo

### 三、一期将默认引入本地 Git 仓库语义

为了让 `Branch` 在一期成为稳定对象，而不是空字段，一期约定：

1. 每个 `Workspace` 都是一个本地 git repo
2. 新建 `Workspace` 时自动初始化本地 git 仓库
3. 默认 branch 为 `main`
4. 迁移 legacy group 时，若目录尚未初始化 git，则自动执行本地 `git init`
5. 一期不接 GitHub / PR / remote clone
6. 一期只使用本地 git 能力：
   - 当前 branch
   - branch 列表
   - checkout
   - fork branch
   - diff / status

这里的 git 语义不限于代码：

1. 可以管理代码
2. 也可以管理任务文档、研究记录、决策文档、草稿和产物

因此 `Workspace` 目录可以自然承载：

```text
TASK.md
context/overview.md
research/route-a.md
research/route-b.md
decisions/2026-04-21.md
deliverables/
```

### 四、Branch 是逻辑工作线，不是并发隔离机制

一期必须明确排除一个误解：

1. 有 branch，不等于可以并发
2. 一期没有 `worktree`
3. 因此同一个 `Workspace` 仍然只有一份真实工作目录

这意味着：

1. `Chat.active_branch` 表示该 chat 当前关注的逻辑工作线
2. `Workspace` 的真实物理目录在某一时刻只 checkout 到一条 branch
3. 某个 run 开始前，系统会把真实目录切到该 chat 的 `active_branch`
4. 因为只有一份工作目录，所以一期同一个 `Workspace` 只能串行运行

这是有意识的收敛，不是功能缺失：

1. 一期先把 `Workspace / Chat / Branch / Run` 模型跑通
2. 二期再引入 `worktree` 解决多 chat 并发执行

### 五、Chat 不再等于外部会话

一期要引入两个绑定层：

1. `WorkspaceBinding`
   - 外部入口到 Workspace 的绑定
   - 例如 `feishu_app_id -> workspace`
2. `ChatBinding`
   - 外部会话到 Chat 的绑定
   - 例如 `feishu chat_id -> chat`

以飞书为例：

```text
FEISHU_APP_ID = 一个 Workspace
某个飞书群 chat_id = 该 Workspace 下的一个 Chat
```

一期不做：

1. 同群线程 `root_id` -> chat
2. 一个飞书群内多个 thread 自动映射多个 chat

一期先采用最稳的规则：

1. 一个飞书群 `chat_id` 对应一个 `Chat`
2. 未来再升级为：
   - 飞书群 = 默认 chat
   - 飞书线程 = 子 chat

### 六、Memory 一期只保留 Workspace 级，不新增 Chat Memory 表

为了控制复杂度，一期不新增独立 `chat_memory` 表。

原因：

1. 当前用户已经明确希望先做第一期，不把系统拉得过重
2. `Chat` 默认是讨论窗口，而不是新的规则主体
3. 共享任务状态应优先落到 workspace / repo 文件，而不是 memory

因此一期约定：

1. 现有 `group_memories` 迁移为 `workspace_memories`
2. 只保留 `Workspace` 级 memory
3. `Chat` 私有状态先由两部分承载：
   - chat message history
   - chat 自己的 `session_ref`

非目标：

1. 不做 `chat_memory`
2. 不做复杂的 memory merge / override

### 七、对现有模块的影响范围

一期会影响以下模块：

1. 数据库层
   - `src/db.ts`
2. Workspace / Chat 服务层
   - 当前 `group-service` 相关逻辑
3. 运行队列与执行协调层
   - 当前 `src/group-queue.ts`
4. Pi runtime 管理层
   - 当前 `src/kernel/group-runtime-manager.ts`
5. Desktop sidecar API
   - `src/desktop/api.ts`
   - `src/desktop/admin-api.ts`
   - `src/desktop/server.ts`
6. CLI 入口
   - `src/cli.ts`
   - `src/cli/*`
7. Feishu 入口与路由
   - `src/channels/feishu.ts`
   - `src/channels/types.ts`
   - `src/router.ts`
8. 文档
   - `README.md`
   - 相关 specs / docs

明确不在一期范围：

1. `git worktree`
2. 同一 `Workspace` 的并发 run
3. 飞书线程自动路由
4. GitHub remote / PR / push
5. chat 私有 memory 表
6. 自动 branch 切换
7. branch 自动创建

## 实现方案

### 一、核心术语与默认行为

一期采用以下固定术语：

```text
Workspace = 稳定工作区主体
Chat      = Workspace 内的讨论窗口
Branch    = Chat 当前绑定的逻辑工作线
Run       = Chat 上的一次执行实例
```

默认行为如下：

1. 新建 `Workspace`
   - 创建 `workspaces/<folder>/`
   - 创建 `AGENTS.md`
   - 创建 `.pi/skills/`
   - 创建 `.pi/sessions/`
   - 初始化本地 git repo
   - 设置 `default_branch = main`

2. 新建 `Chat`
   - 必须属于某个 `Workspace`
   - 默认绑定 `workspace.default_branch`
   - 创建自己的 `session_ref`
   - 不自动创建新的 branch

3. 切 branch
   - 必须显式确认
   - 有 active run 时禁止切换
   - workspace dirty 时需要二次确认
   - 切换后写入 chat system event

4. 启动 run
   - 读取 chat 的 `active_branch`
   - 确保 Workspace 真实目录 checkout 到该 branch
   - 继续该 chat 的 `session_ref`
   - 同一 Workspace 一次只允许一个 active run

### 二、推荐的数据模型

一期新增如下表结构，并逐步淘汰当前的 `registered_groups` / `sessions(group_folder -> session_ref)` 模型。

#### 1. workspaces

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

说明：

1. `folder` 对应 `workspaces/<folder>/`
2. `default_branch` 一期固定要求非空

#### 2. workspace_bindings

```sql
CREATE TABLE workspace_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(platform, external_id)
);
```

示例：

1. `platform = feishu_app`
2. `external_id = FEISHU_APP_ID`

#### 3. chats

```sql
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  active_branch TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);
```

说明：

1. 一期 `active_branch` 非空
2. `session_ref` 迁移自当前 group-only 模型，但粒度变成 chat

#### 4. chat_bindings

```sql
CREATE TABLE chat_bindings (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  external_thread_id TEXT,
  created_at TEXT NOT NULL
);
```

一期使用方式：

1. 飞书只填 `external_chat_id`
2. `external_thread_id` 先保留字段，不在一期启用
3. 唯一索引在实现时使用真实数据库支持的表达方式处理，不强行写死在当前 spec 中

#### 5. workspace_memories

```sql
CREATE TABLE workspace_memories (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'builtin',
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
```

说明：

1. 直接承接现有 `group_memories`
2. 一期不新增 `chat_memories`

#### 6. runs

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL,
  branch TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  cancel_requested_at TEXT,
  error TEXT
);
```

建议状态：

1. `queued`
2. `running`
3. `completed`
4. `failed`
5. `cancelled`
6. `waiting_confirmation`

#### 7. run_events

```sql
CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

用途：

1. 支撑可观测
2. 支撑重连
3. 支撑 desktop / CLI 回放

#### 8. workspace_runtime_state

```sql
CREATE TABLE workspace_runtime_state (
  workspace_id TEXT PRIMARY KEY,
  checked_out_branch TEXT NOT NULL,
  active_run_id TEXT,
  status TEXT NOT NULL,
  last_activity_at TEXT,
  unload_after TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

说明：

1. 由于一期没有 `worktree`，同一 Workspace 只有一个真实工作目录
2. 因此需要持久化“当前物理目录 checkout 到哪条 branch”

### 三、推荐的 TypeScript 领域接口

建议逐步把当前 group-centric 类型改为如下模型：

```ts
export interface Workspace {
  id: string;
  name: string;
  folder: string;
  defaultBranch: string;
  status: "active" | "archived";
}

export interface Chat {
  id: string;
  workspaceId: string;
  title: string;
  activeBranch: string;
  sessionRef: string;
  status: "active" | "archived";
}

export interface Run {
  id: string;
  workspaceId: string;
  chatId: string;
  branch: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "waiting_confirmation";
}
```

### 四、目录与迁移策略

一期建议新增顶层目录：

```text
workspaces/
  <folder>/
    AGENTS.md
    .pi/
      skills/
      sessions/
```

迁移策略：

1. 现有每个 `group` 先迁移成一个 `legacy workspace`
2. 为每个 legacy workspace 自动创建一个默认 chat
3. 旧 `group` 对应的 `session_ref` 迁到默认 chat
4. 旧 `group_memories` 迁到 `workspace_memories`
5. 旧 `registered_groups` 暂时保留，只作为迁移输入，不再作为新主表

迁移示意：

```ts
for (const group of listLegacyGroups()) {
  const workspace = createWorkspaceFromLegacyGroup(group);
  const chat = createDefaultChatForWorkspace(workspace.id);
  migrateSessionRef(group.folder, chat.id);
  migrateGroupMemories(group.folder, workspace.id);
}
```

### 五、运行时重构方案

#### 1. GroupQueue 重构为按 Workspace 串行的运行协调器

当前 `src/group-queue.ts` 需要被新的运行协调器替代，建议命名：

```text
src/workspace-run-coordinator.ts
```

职责：

1. 队列项从 `groupFolder` 改为 `(workspaceId, chatId, runId)`
2. 锁粒度从 `groupFolder` 改为 `workspaceId`
3. 同一 Workspace 一次只允许一个 active run
4. run 开始、结束、失败、取消都必须落库

运行前流程：

```ts
async function startRun(run: Run) {
  const chat = getChat(run.chatId);
  const workspace = getWorkspace(run.workspaceId);

  await ensureWorkspaceOnBranch(
    workspace.id,
    chat.activeBranch,
  );

  const runtime = await chatRuntimeManager.ensureRuntime(chat.id);
  await runtime.prompt(...);
}
```

#### 2. GroupRuntimeManager 重构为 ChatRuntimeManager

当前 `src/kernel/group-runtime-manager.ts` 的核心价值仍然保留，但粒度要改：

1. 当前 keyed by `groupFolder`
2. 一期改为 keyed by `chatId`

建议命名：

```text
src/kernel/chat-runtime-manager.ts
src/kernel/chat-types.ts
```

职责：

1. 为某个 `chatId` 懒加载或恢复 Pi runtime
2. 使用 chat 的 `session_ref`
3. 将 Pi 的 session event 转成 `run_events`
4. 输出 chat snapshot 和 event stream

核心变化：

1. `session_ref` 不再属于 group / workspace
2. `session_ref` 属于 chat

#### 3. Workspace runtime state 负责记录物理目录的 branch

因为一期没有 `worktree`，所以需要一个持久状态表记录：

1. 当前真实目录在哪条 branch
2. 当前是否有 active run

切 branch 和 run 启动都要经过这一层检查。

示意：

```ts
async function ensureWorkspaceOnBranch(
  workspaceId: string,
  targetBranch: string,
) {
  const runtimeState = getWorkspaceRuntimeState(workspaceId);
  if (runtimeState.activeRunId) {
    throw new Error("Cannot switch branch while workspace has active run");
  }

  if (runtimeState.checkedOutBranch !== targetBranch) {
    await checkoutBranch(workspaceId, targetBranch);
    saveWorkspaceRuntimeState({
      workspaceId,
      checkedOutBranch: targetBranch,
    });
  }
}
```

### 六、Branch 管理策略

一期的 branch 管理要非常克制：

1. 新 chat 默认绑定 `workspace.default_branch`
2. 不自动新建 branch
3. `switch branch` 是显式确认动作
4. `fork branch` 是显式动作
5. 同一 branch 可被多个 chat 引用
6. 同一 branch 不允许并发 run

建议只提供以下最小能力：

1. `list_branches`
2. `switch_chat_branch`
3. `fork_branch_for_chat`
4. `show_workspace_git_status`

一期不做：

1. merge
2. remote push
3. PR
4. worktree
5. auto stash / auto commit / auto rebase

### 七、Feishu / Desktop / CLI 的接入方式

#### 1. Feishu

一期规则：

1. `FEISHU_APP_ID` 对应一个 `Workspace`
2. 每个飞书群 `chat_id` 对应该 Workspace 下的一个 `Chat`
3. 如果 `chat_id` 首次出现，则自动创建 chat 绑定
4. 不处理线程 `root_id`

路由示意：

```ts
const workspace = findWorkspaceByBinding("feishu_app", FEISHU_APP_ID);
const chat = findOrCreateChatByBinding({
  workspaceId: workspace.id,
  platform: "feishu_chat",
  externalChatId: message.chatId,
});
enqueueRun({
  workspaceId: workspace.id,
  chatId: chat.id,
});
```

#### 2. Desktop

Desktop API 从当前：

```text
/api/desktop/groups
/api/desktop/groups/:folder/...
```

改为：

```text
/api/desktop/workspaces
/api/desktop/workspaces/:workspaceId/chats
/api/desktop/workspaces/:workspaceId/chats/:chatId/snapshot
/api/desktop/workspaces/:workspaceId/chats/:chatId/prompt
/api/desktop/workspaces/:workspaceId/chats/:chatId/abort
/api/desktop/workspaces/:workspaceId/chats/:chatId/events
/api/desktop/workspaces/:workspaceId/chats/:chatId/branch/switch
/api/desktop/workspaces/:workspaceId/chats/:chatId/branch/fork
```

#### 3. CLI

CLI 一期增加：

1. workspace 级命令
   - 创建 workspace
   - 列出 workspace
   - 切换 workspace
2. chat 级命令
   - 创建 chat
   - 列出 chat
   - 切换 chat

### 八、运行态持久化与可观测

一期的核心目标之一是把当前内存态落库。

至少要持久化：

1. `runs`
2. `run_events`
3. `workspace_runtime_state`
4. `chats.session_ref`

运行事件建议覆盖：

1. `message_start`
2. `message_delta`
3. `message_end`
4. `tool_start`
5. `tool_update`
6. `tool_end`
7. `queue_update`
8. `agent_end`
9. `error`
10. `branch_switched`

这样 desktop 和 CLI 都能做到：

1. run 历史查看
2. 断线重连
3. 失败定位
4. branch 切换回溯

### 九、一期明确不做 worktree

虽然 `git worktree` 是二期支持多 chat 并发的正确方向，但一期明确不实现。

原因：

1. 一期要先把 `Workspace / Chat / Branch / Run` 的数据边界和接口跑通
2. 当前项目仍然是 group-centric，先重构抽象边界更重要
3. 如果一期同时引入 worktree，会显著扩大：
   - 生命周期管理
   - 磁盘清理
   - branch/worktree 映射
   - 并发冲突处理

因此一期明确采用：

```text
single workspace root
single active run per workspace
no worktree
```

二期再讨论：

1. `worktree` 是按 branch 长驻还是按 run 临时创建
2. 多 chat 并发时的隔离与调度

## Todo List

- [x] 梳理并确认一期术语与边界
- [x] 将领域模型从 `group` 拆分为 `workspace / chat / run / binding`
- [x] 设计并实现 `workspaces`、`workspace_bindings`、`chats`、`chat_bindings`、`workspace_memories`、`runs`、`run_events`、`workspace_runtime_state` 表
- [x] 设计 legacy `group` -> `workspace + default chat` 的迁移脚本
- [x] 将工作区根目录从 `groups/` 迁移到 `workspaces/`
- [x] 为每个 workspace 工作区补齐 `AGENTS.md`、`.pi/skills/`、`.pi/sessions/`
- [x] 为每个 workspace 初始化本地 git repo，并设置 `default_branch = main`
- [x] 将现有 `group_memories` 迁移为 `workspace_memories`
- [x] 将现有 group 级 `session_ref` 迁移到默认 chat
- [ ] 重构 `src/group-queue.ts` 为按 workspace 串行的运行协调器
- [x] 重构 `src/kernel/group-runtime-manager.ts` 为按 chat 管理 runtime 的 manager
- [x] 将 chat 的 `session_ref` 接入 Pi runtime 恢复链路
- [x] 为 run 开始、结束、失败、取消、确认等待等状态落库
- [x] 为消息、工具、错误、branch 切换等事件落 `run_events`
- [x] 实现 `workspace_runtime_state`，持久化当前 checkout branch、active run 和 unload 时间
- [x] 实现 branch 最小能力：列表、显式切换、显式 fork
- [x] 加入 branch 切换保护：active run 禁止切换，dirty workspace 需确认
- [x] 重构 desktop API，从 `groups/:folder` 改为 `workspaces/:workspaceId/chats/:chatId`
- [x] 新增 desktop 的 workspace/chat 列表、snapshot、prompt、abort、events、branch API
- [x] 重构 CLI，使其支持 workspace/chat 级切换与创建
- [x] 重构 Feishu 路由：`FEISHU_APP_ID -> workspace`，`feishu chat_id -> chat`
- [x] 一期只按飞书群 `chat_id` 建立 chat 绑定，不处理 `root_id`
- [x] 更新 README 与相关文档，统一改成 Workspace/Chat 语义
- [x] 为迁移逻辑、workspace/chat 服务、run 持久化、branch 保护、desktop API、Feishu 路由补充测试
- [x] 在一期完成前，明确保持 `worktree` 与并发 run 为非目标
