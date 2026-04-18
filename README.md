# Octo

Octo 是一个面向飞书群的多群 AI Agent 编排系统。当前版本已经完全切到 Pi-native runtime：底层统一由 `PiProvider` 驱动，群组间通过 `profile_key` 选择模型线路，群工作区统一采用 `AGENTS.md + .pi/skills + .pi/sessions`。

## 特性

- Pi-native runtime：所有群组都走同一条 `PiProvider` 链路
- 多 profile 路由：通过配置文件切到不同模型和上游接口
- 多群隔离：每个群有独立工作目录、独立 session ref、独立技能目录
- 外部 MCP 扩展：按群技能 gate，再通过 Pi extension 注入
- MiniMax 能力：统一图片理解预处理，支持文生图落盘后回传
- 群级长期记忆：数据库持久化，自动注入新会话和定时任务
- 定时任务：按群独立调度，支持跨群任务创建

## 架构

```text
飞书群消息
  → Channel / Router
    → GroupQueue
      → resolveAgentProfile(group.profile_key)
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

每个群目录统一为：

```text
groups/<folder>/
  AGENTS.md
  .pi/
    skills/
    sessions/
```

- `AGENTS.md`：该群指令文件
- `.pi/skills/`：该群技能目录
- `.pi/sessions/`：Pi 本地 session 文件

启动时会自动做一次轻量迁移辅助：

- 若仅存在 `CLAUDE.md`，复制为 `AGENTS.md`
- 若仅存在 `.claude/skills`，复制到 `.pi/skills`

运行时只读取新路径，不再依赖 `.claude` 目录。

## 数据模型

核心字段已经切换为 Pi-first 语义：

- `registered_groups.profile_key`：当前群使用的模型线路 key
- `sessions.session_ref`：Pi 本地 session 文件引用

这意味着：

- 切 profile 使用 `switch_profile`
- 清上下文使用 `clear_session`
- 切 profile 不会隐式删除 session ref

如需直接修改数据库：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET profile_key = 'minimax-cn' WHERE folder = 'main';"
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

主群里可用的管理工具：

- `list_profiles`
- `switch_profile`
- `list_groups`
- `register_group`

## 群记忆

群级长期记忆存储在 SQLite `group_memories` 表中，会在新会话启动时自动注入。

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

系统技能和 curated skills 都会安装到群目录的 `.pi/skills/` 下。

- `list_curated_skills`
- `install_curated_skill`

外部 MCP 通过 `config/external-mcp*.json` 配置，再由 `PiProvider` 在启动 session 时转成 Pi extension 注入。某些 MCP 能力可以再由群技能控制是否暴露，例如 `pdf-to-markdown`。

## 相关文档

- [项目文档](docs/octo.md)
- [Pi Runtime 与 Profile 路由](docs/multi-agent-provider.md)
