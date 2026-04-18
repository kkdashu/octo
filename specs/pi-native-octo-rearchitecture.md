# 以 Pi First 方式重构 Octo

## 问题描述

当前 `octo` 的底层运行时已经切到 `PiProvider`，`@anthropic-ai/claude-agent-sdk` 也已经从主链路中移除，但整个项目的“组织方式”仍然停留在 Claude 时代。这导致现在的 `octo` 处于一种尴尬状态：

1. **执行是 Pi 的，项目约定却还是 Claude 的**
   - `src/index.ts` 仍然创建 `groups/MAIN_CLAUDE.md`、`groups/GROUP_CLAUDE.md`
   - group 级 skill 仍同步到 `groups/<folder>/.claude/skills`
   - `src/providers/pi.ts` 仍通过 `additionalSkillPaths` 兼容读取 `.claude/skills`
   - 仓库内真实 group 工作目录仍是 `CLAUDE.md + .claude/skills`

2. **数据模型仍把“profile”当成“provider”**
   - `registered_groups.agent_provider` 这个字段名来自旧架构，语义上已经不准确
   - `src/tools.ts` 仍提供 `switch_provider`
   - `src/admin/*` 和 API DTO 仍使用 `agentProvider`
   - `src/group-queue.ts` 仍在没有值时硬编码 fallback 到 `"claude"`

3. **文档和默认叙事还在误导维护者**
   - `README.md` 仍写“统一 runtime：ClaudeProvider / Claude Agent SDK”
   - 群模板文案仍是“Claude session / CLAUDE.md / Claude tools”的思维模式
   - `docs/claude_agent_sdk/`、`docs/multi-agent-provider.md` 仍然描述已经过时的架构

如果继续在这个状态上叠功能，`octo` 会长期停留在“底层已经是 Pi，但所有上层概念都还在假装 Claude”的混合模型里。这样的问题不是“文案不整洁”这么简单，而是会持续影响：

- 新功能设计会继续沿着旧语义扩散
- 后续维护者很难判断哪些兼容层仍然是必需的
- 数据结构、工具命名、目录结构都会继续固化错误抽象

本轮目标不是再做一层兼容，而是明确把 `octo` 的工程组织切换成 **Pi First**：

1. group 工作目录改成 Pi/Agent 通用约定，而不是 Claude 兼容约定
2. 数据库和 API 改成“profile”语义，而不是“provider / agent sdk”语义
3. 文档、后台、工具、测试全部围绕 Pi runtime 重新命名和组织
4. 删除剩余的 Claude 时代兼容层，而不是继续保留

本轮非目标：

- 不删除 “Claude 模型 profile” 本身。`claude` 仍可作为一个可选 profile key 存在，只是不再代表底层运行时。
- 不重写 `octo` 的群队列、消息路由、任务调度等业务主流程。
- 不修改 `octo` 工具集与外部 MCP 的核心能力边界。
- 不把 `octo` 直接改造成 Pi CLI/TUI 产品；仍保持当前 Feishu 群编排产品形态。

## 对现有项目的影响

### 一、目录与工作区约定变化

每个群组目录从：

```text
groups/<folder>/CLAUDE.md
groups/<folder>/.claude/skills/
```

迁移为：

```text
groups/<folder>/AGENTS.md
groups/<folder>/.pi/skills/
```

原因：

1. `pi` 自身就会优先读取 `AGENTS.md`
2. `pi` 自身默认会读取 `cwd/.pi/skills`
3. 继续显式兼容 `.claude/skills` 只会把旧约定永久保留下来

这意味着以下文件与逻辑要改：

- `src/index.ts`
  - `ensureClaudeMd()` 改为 `ensureAgentsMd()`
  - `MAIN_CLAUDE.md` / `GROUP_CLAUDE.md` 改为 `MAIN_AGENTS.md` / `GROUP_AGENTS.md`
  - `syncSystemSkills()` 改为同步到 `.pi/skills`
- `src/group-queue.ts`
  - `isGroupSkillInstalled()` 改为检查 `.pi/skills/<name>/SKILL.md`
- `src/tools.ts`
  - curated skill 安装目标从 `.claude/skills` 改为 `.pi/skills`
- `src/providers/pi.ts`
  - 删除对 `.claude/skills` 的 `additionalSkillPaths` 兼容注入
  - 直接依赖 `DefaultResourceLoader` 的 `.pi/skills` 默认发现

### 二、数据库与业务语义变化

当前数据库里仍有两个明显的旧命名：

1. `registered_groups.agent_provider`
2. `sessions.session_id`

在 Pi-first 架构里，这两个名字都不准确：

- `agent_provider` 实际保存的是 profile key，而不是 provider/sdk
- `session_id` 实际保存的是 Pi 本地 session 文件引用，而不是远端 session id

因此本轮建议直接做数据库语义升级：

1. `registered_groups.agent_provider` 重命名为 `profile_key`
2. `sessions.session_id` 重命名为 `session_ref`

配套影响：

- `src/db.ts`
  - `RegisteredGroup.agent_provider` 改为 `profile_key`
  - `registerGroup(... agentProvider?)` 改为 `profileKey?`
  - `updateGroupProvider()` 改为 `updateGroupProfile()`
  - `getSessionId()/saveSessionId()/deleteSessionId()` 改为 `getSessionRef()/saveSessionRef()/deleteSessionRef()`
- `src/group-queue.ts`
  - 全部改读写 `profile_key` / `session_ref`
- `src/admin/api.ts`、`src/admin/types.ts`、`src/admin/App.tsx`
  - DTO 字段统一改为 `profileKey`
- `tests/*`
  - 所有 fixture 与断言改成新字段名

### 三、默认 profile 解析逻辑变化

当前 `src/group-queue.ts` 里仍有：

```ts
const requestedProfileKey = group.agent_provider || "claude";
```

这不符合 Pi-first 的项目设计，因为：

1. 底层运行时已经固定是 Pi，不应再把 `"claude"` 视为系统默认
2. 仓库真实默认 profile 已经是 `config/agent-profiles.json` 中的 `defaultProfile`

因此本轮要把所有默认值来源统一收口到 profile 配置文件：

```ts
const config = loadAgentProfilesConfig();
const requestedProfileKey = group.profile_key || config.defaultProfile;
```

这会影响：

- `src/group-queue.ts`
- `src/db.ts` 中新 group 的默认 profile
- 管理后台默认显示
- 测试里的 fixture 默认值

### 四、工具与后台命名变化

在 Pi-first 架构里，“switch provider” 这种说法已经误导，因为运行时 provider 只有一个：Pi。

因此工具和后台都应该改成 profile 语义：

- `switch_provider` 改为 `switch_profile`
- `agentProvider` 改为 `profileKey`
- 后台标签 “AI 引擎” 改为 “Profile / 模型线路”

建议本轮直接移除旧名字，不保留兼容别名。原因是用户已明确接受不兼容历史方案，继续保留别名只会延长迁移尾巴。

涉及文件：

- `src/tools.ts`
- `src/admin/api.ts`
- `src/admin/types.ts`
- `src/admin/App.tsx`
- `groups/MAIN_AGENTS.md`
- `groups/GROUP_AGENTS.md`
- 相关测试与 README

### 五、文档与模板清理

当前仓库的 README 和部分 docs 仍在描述 Claude SDK 时代的架构。Pi-first 重构完成后，如果这些文档不一起改，后续维护成本会非常高。

因此本轮要同步清理：

- 重写 `README.md`
  - 架构图改为 `GroupQueue -> PiProvider -> pi-mono`
  - 删除 Claude SDK、OpenAI proxy、Anthropic proxy 的旧表述
  - 更新 group workspace 说明为 `AGENTS.md + .pi/skills`
- 删除或归档 `docs/claude_agent_sdk/`
- 重写 `docs/multi-agent-provider.md`

## 实现方案

### 一、把 group workspace 改成 Pi 原生约定

新的 group 工作目录标准：

```text
groups/<folder>/
  AGENTS.md
  .pi/
    skills/
```

实现策略：

1. 新建模板文件：
   - `groups/MAIN_AGENTS.md`
   - `groups/GROUP_AGENTS.md`

2. `src/index.ts` 中：
   - `ensureClaudeMd()` 重命名为 `ensureAgentsMd()`
   - 模板来源改为 `MAIN_AGENTS.md` / `GROUP_AGENTS.md`
   - `syncSystemSkills()` 目标路径改为 `.pi/skills`

3. 对已有群目录做一次本地迁移辅助：
   - 如果 `AGENTS.md` 不存在但 `CLAUDE.md` 存在，则复制 `CLAUDE.md -> AGENTS.md`
   - 如果 `.pi/skills` 不存在但 `.claude/skills` 存在，则复制 `.claude/skills -> .pi/skills`

这里建议用“复制而不是删除”的迁移策略：

- 可以避免误删用户已有 prompt / skill 数据
- 迁移完成后运行时只读新路径，不再引用旧路径
- 等验证稳定后，再决定是否单独清理旧文件

示意：

```ts
function migrateLegacyGroupWorkspace(folder: string) {
  const legacyAgents = `groups/${folder}/CLAUDE.md`;
  const agents = `groups/${folder}/AGENTS.md`;
  if (!existsSync(agents) && existsSync(legacyAgents)) {
    copyFileSync(legacyAgents, agents);
  }

  const legacySkills = `groups/${folder}/.claude/skills`;
  const piSkills = `groups/${folder}/.pi/skills`;
  if (!existsSync(piSkills) && existsSync(legacySkills)) {
    copyDirRecursive(legacySkills, piSkills);
  }
}
```

### 二、移除 `.claude` 路径兼容层

当前 `src/providers/pi.ts` 仍然显式注入：

```ts
additionalSkillPaths: [
  resolve(config.workingDirectory, ".claude", "skills"),
]
```

Pi-first 方案里应该删除这层兼容，理由是：

1. `.pi/skills` 已经是 `DefaultResourceLoader` 的默认项目路径
2. 继续显式读 `.claude/skills` 会让迁移永远无法完成

调整后：

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd: config.workingDirectory,
  extensionFactories: mcpBundle.extensionFactories,
});
```

同理，以下路径也都统一改成 `.pi/skills`：

- `src/group-queue.ts` 的 skill gate
- `src/tools.ts` 的 curated skill 安装与查询
- 各种测试 fixture

### 三、把数据模型改成 profile / session ref 语义

建议直接升级 schema，而不是继续保留误导性的旧字段名。

#### 1. `registered_groups`

目标字段：

```text
profile_key TEXT NOT NULL
```

替代：

```text
agent_provider TEXT
```

#### 2. `sessions`

目标字段：

```text
session_ref TEXT NOT NULL
```

替代：

```text
session_id TEXT
```

#### 3. 迁移策略

如果当前 SQLite 版本支持，可优先直接 `RENAME COLUMN`：

```sql
ALTER TABLE registered_groups RENAME COLUMN agent_provider TO profile_key;
ALTER TABLE sessions RENAME COLUMN session_id TO session_ref;
```

若运行环境对 `RENAME COLUMN` 存在兼容性风险，则退回到：

1. 新建临时表
2. `INSERT INTO ... SELECT ...`
3. 删除旧表
4. 重命名新表

代码层改造点：

- `src/db.ts`
  - 类型、SQL、helper 名称全部改掉
- `src/group-queue.ts`
  - `getSessionRef/saveSessionRef/deleteSessionRef`
  - `group.profile_key`
- `src/admin/api.ts`
  - patch payload 改成 `profileKey`

### 四、去掉硬编码 `"claude"` 默认值

这是一个真正的架构问题，不只是命名问题。

当前 fallback 到 `"claude"` 会造成：

- 新注册 group 即使配置默认 profile 是 `codex`，也可能在某些路径继续使用 `claude`
- 数据层与运行时层的默认行为不一致

Pi-first 方案应该统一为：

1. **数据库层**：新 group 默认写入 `loadAgentProfilesConfig().defaultProfile`
2. **运行时层**：当 group 未配置 profile 时，也读取 `defaultProfile`

示意：

```ts
const profileConfig = loadAgentProfilesConfig();
const profileKey = group.profile_key || profileConfig.defaultProfile;
```

### 五、把工具 / API / Admin 统一成 Profile 语义

在 Pi-first 项目里：

- provider 是固定的 `PiProvider`
- 可切换的是 profile，不是 provider

因此建议直接重命名：

1. tool
   - `switch_provider` -> `switch_profile`

2. 后台字段
   - `agentProvider` -> `profileKey`

3. UI 文案
   - “AI 引擎” -> “模型线路”
   - “switch provider” -> “switch profile”

4. group 模板提示
   - 更新 `AGENTS.md` 中可用工具表与使用说明

本轮不保留 `switch_provider` 兼容 alias，避免双命名长期共存。

### 六、保留 Pi 兼容的部分，不做无谓重命名

本轮不是“把所有旧词一口气全删掉”，而是只删除真正会阻碍架构演进的那部分。

以下内容建议保留：

1. `claude` profile key 可以保留
   - 它表示模型线路，不表示 SDK
   - 只要不再作为系统默认/底层 runtime 语义，就没有问题

2. `mcp__octo-tools__*` 工具名前缀保留
   - 这是现有 prompt 与工具生态的一部分
   - 与 Pi 不冲突

3. `list_profiles` 工具保留
   - 它本身已经是正确抽象

### 七、文档重写与历史资料清理

Pi-first 落地后，文档应反映真实架构。

#### `README.md`

需要改成：

```text
飞书群消息
  -> Channel / Router
    -> GroupQueue
      -> resolveAgentProfile(group.profile_key)
      -> PiProvider
        -> pi-mono / createAgentSession()
```

并更新以下说明：

- 群目录是 `AGENTS.md + .pi/skills`
- profile 是模型线路，不是 SDK
- session 恢复使用本地 Pi session ref

#### 历史文档

建议处理方式：

- 删除 `docs/claude_agent_sdk/`
- 重写 `docs/multi-agent-provider.md`

如果不想直接删，也至少要移动到 `docs/archive/`，避免新维护者把过时资料当现状。

### 八、测试策略

本轮的测试要覆盖“Pi-first 项目约定”本身，而不是只验证 `PiProvider` 能跑。

至少需要补齐：

1. `tests/runtime.test.ts`
   - 数据库列/默认值语义改成 `profile_key`、`session_ref`
   - fallback 走 `defaultProfile` 而不是 `"claude"`

2. `tests/group-queue.test.ts`
   - group skill gate 改读 `.pi/skills`
   - session ref 新字段名回归通过

3. `tests/admin-api.test.ts`
   - API patch payload 改为 `profileKey`
   - 文件浏览默认读 `AGENTS.md`

4. `tests/admin-group-files.test.ts`
   - 用 `AGENTS.md` fixture 替代 `CLAUDE.md`

5. `tests/providers.test.ts`
   - 删除对 `.claude` 路径的测试依赖
   - 如需要，补一个 `.pi/skills` 发现行为测试

6. `tests/group-memory.test.ts` / `tests/router.test.ts`
   - 更新 group fixture 的 `profileKey`

## Todo List

### Phase 0: 方案确认
- [x] 确认本轮按 Pi-first 改目录、数据模型、工具命名和文档，不再保留 `.claude` / `agent_provider` / `switch_provider` 兼容层

### Phase 1: Group Workspace 迁移
- [x] 新建 `groups/MAIN_AGENTS.md`
- [x] 新建 `groups/GROUP_AGENTS.md`
- [x] 修改 `src/index.ts`，用 `AGENTS.md` 替代 `CLAUDE.md`
- [x] 修改 `src/index.ts`，把 system skills 同步到 `.pi/skills`
- [x] 在启动链路增加 legacy workspace 迁移辅助：`CLAUDE.md -> AGENTS.md`、`.claude/skills -> .pi/skills`
- [x] 修改 `src/providers/pi.ts`，删除 `.claude/skills` 的 `additionalSkillPaths` 兼容层
- [x] 修改 `src/group-queue.ts`，group skill gate 改读 `.pi/skills`
- [x] 修改 `src/tools.ts`，curated skill 安装/查询路径改为 `.pi/skills`

### Phase 2: 数据模型与命名迁移
- [x] 修改 `src/db.ts`，把 `registered_groups.agent_provider` 升级为 `profile_key`
- [x] 修改 `src/db.ts`，把 `sessions.session_id` 升级为 `session_ref`
- [x] 修改 `src/db.ts` 的类型、helper 和 SQL，统一使用 `profileKey` / `sessionRef`
- [x] 修改 `src/group-queue.ts`，移除对 `group.agent_provider` 和 `session_id` 的引用
- [x] 修改 `src/group-queue.ts`，默认 profile 回退到配置文件的 `defaultProfile`

### Phase 3: Tool / API / Admin 改名
- [x] 修改 `src/tools.ts`，将 `switch_provider` 改为 `switch_profile`
- [x] 修改 `src/admin/types.ts`，把 `agentProvider` DTO 改为 `profileKey`
- [x] 修改 `src/admin/api.ts`，使用 `profileKey` 读写 group 配置
- [x] 修改 `src/admin/App.tsx`，把“AI 引擎 / agentProvider”改成“模型线路 / profileKey”

### Phase 4: 文档与模板清理
- [x] 重写 `README.md`，改成 Pi runtime 架构说明
- [x] 删除或归档 `docs/claude_agent_sdk/`
- [x] 重写 `docs/multi-agent-provider.md`
- [x] 更新 group 模板中的工具名、session 描述和工作目录说明

### Phase 5: 测试与验证
- [x] 更新 `tests/runtime.test.ts`
- [x] 更新 `tests/group-queue.test.ts`
- [x] 更新 `tests/admin-api.test.ts`
- [x] 更新 `tests/admin-group-files.test.ts`
- [x] 更新 `tests/providers.test.ts`
- [x] 更新其他受影响测试 fixture 的 `profileKey` / `sessionRef` / `AGENTS.md` 断言
- [x] 运行 `bun test tests/*.test.ts`
