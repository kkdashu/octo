# Octo

Octo 现在的一等模型是 `Workspace / Chat / Run`，不再把“外部群聊、工作目录、对话窗口”混成一个 `group`。当前版本已经切到 Pi-native runtime：底层统一由 `PiProvider` 驱动，Workspace 共享 `AGENTS.md + .pi/skills + .pi/sessions`，每个 Chat 持有自己的 `session_ref` 和 active branch。

## 特性

- Workspace / Chat 模型：同一 Workspace 下可以有多个 Chat，共享目录、技能和长期约束
- Pi-native runtime：所有入口都走同一条 `PiProvider` 链路
- Chat 级 session 恢复：每个 Chat 独立保存 `session_ref`
- Run 持久化：运行状态、事件流和 workspace runtime state 都会落库
- Branch 能力：Chat 默认绑定 `workspace.default_branch`，支持显式切换与 fork
- 外部 MCP 扩展：按 Workspace 技能 gate，再通过 Pi extension 注入
- MiniMax 能力：统一图片理解预处理，支持文生图落盘后回传
- Workspace 级长期记忆：数据库持久化，自动注入新会话和定时任务

## 架构

```text
飞书 / CLI / Desktop 消息
  → Channel / Router / Sidecar API
    → Workspace / Chat 绑定
      → GroupRuntimeManager
        → resolveAgentProfile(workspace.profile_key)
        → PiProvider
          → pi-mono coding-agent
            → builtin tools
            → octo custom tools
            → Pi MCP extensions
```

## 快速开始

```bash
bun install
cp env.example .env
# 编辑 .env，填入飞书凭证和各模型线路 API Key

bun run start
```

Profile 配置文件按以下顺序加载：

1. `AGENT_PROFILES_PATH`
2. `config/agent-profiles.json`
3. `config/agent-profiles.example.json`

外部 MCP 配置按以下顺序加载：

1. `EXTERNAL_MCP_CONFIG_PATH`
2. `config/external-mcp.json`
3. `config/external-mcp.example.json`

## 工作区约定

每个 Workspace 目录统一为：

```text
workspaces/<folder>/
  AGENTS.md
  .pi/
    skills/
    sessions/
```

- `AGENTS.md`：Workspace 指令文件
- `.pi/skills/`：Workspace 共享技能目录
- `.pi/sessions/`：Pi 本地 session 文件，多个 Chat 会引用其中不同 session

兼容层仍然保留：

- legacy `groups/<folder>/` 会尽量迁移或软链接到 `workspaces/<folder>/`
- legacy `registered_groups` / `sessions` / `group_memories` 继续保留，用于兼容旧入口和旧工具

启动时会自动做一次轻量迁移辅助：

- 若仅存在 `CLAUDE.md`，复制为 `AGENTS.md`
- 若仅存在 `.claude/skills`，复制到 `.pi/skills`

运行时只读取新路径，不再依赖 `.claude` 目录。

## 数据模型

核心字段已经切换为 Workspace / Chat 语义：

- `workspaces.default_branch`：Workspace 默认 branch
- `chats.session_ref`：Chat 当前绑定的 Pi session 文件
- `runs` / `run_events`：Chat 级运行记录与可观测事件
- `workspace_runtime_state`：当前 checkout branch、active run、最近活动时间

这意味着：

- 切 profile 作用在 Workspace
- 清上下文作用在当前 Chat
- branch 切换需要显式确认
- 同一 Workspace 一期仍然只允许一个 active run

如需直接修改数据库：

```bash
sqlite3 store/messages.db "UPDATE workspaces SET profile_key = 'minimax-cn' WHERE folder = 'main';"
```

## Profile 路由

`profile_key` 只表示模型线路，不表示底层 SDK。底层运行时始终是 Pi。

配置示例见 [config/agent-profiles.example.json](config/agent-profiles.example.json)。

- `defaultProfile` 决定新群默认线路
- `apiFormat` 决定 Pi 走 `anthropic-messages` 还是 OpenAI 兼容 API
- `provider = moonshot` 会按兼容规则修正到 Moonshot 对应 endpoint
- `minimax` 使用国际区 Anthropic 兼容 endpoint 与 `MINIMAX_API_KEY`
- `minimax-cn` 使用中国区 Anthropic 兼容 endpoint 与 `MINIMAX_CN_API_KEY`
- `codingPlanEnabled` 可用于区分普通 Kimi 与 coding plan 线路

主 Workspace 里可用的管理工具：

- `list_profiles`
- `switch_profile`
- `list_groups`
- `register_group`

## Workspace 记忆

长期记忆会迁移并收敛到 Workspace 级，运行时注入到新会话启动链路中。legacy `group_memories` 仍会同步到 `workspace_memories`。

可用工具：

- `remember_group_memory`
- `list_group_memory`
- `forget_group_memory`
- `clear_group_memory`

内置 key：

- `topic_context`
- `response_language`
- `response_style`
- `interaction_rule`

## Curated Skills 与外部 MCP

系统技能和 curated skills 都会安装到 Workspace 目录的 `.pi/skills/` 下。

- `list_curated_skills`
- `install_curated_skill`

外部 MCP 通过 `config/external-mcp*.json` 配置，再由 `PiProvider` 在启动 session 时转成 Pi extension 注入。某些 MCP 能力可以再由 Workspace 技能控制是否暴露，例如 `pdf-to-markdown`。

## 相关文档

- [项目文档](docs/octo.md)
- [Pi Runtime 与 Profile 路由](docs/multi-agent-provider.md)
