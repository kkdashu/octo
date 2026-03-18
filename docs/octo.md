# Octo 项目文档

## 项目概述

Octo 是一个多群组 AI Agent 编排系统，连接即时通讯平台（飞书）与多种 AI Agent 后端（Claude、Codex、Kimi），让每个群组拥有独立的 AI 助手，具备文件操作、代码执行、定时任务、技能扩展等能力。

## 架构总览

```
即时通讯平台                   Octo 核心                        AI Agent 后端
┌──────────┐            ┌─────────────────┐            ┌─────────────────┐
│  飞书     │  webhook   │  ChannelManager  │            │  ClaudeProvider  │
│  (未来:   │ ────────→  │       ↓          │            │  CodexProvider   │
│  Slack,   │            │    Router        │            │  KimiProvider    │
│  Discord) │            │       ↓          │            │  (可扩展...)     │
│           │  ←──────── │  GroupQueue       │ ────────→  │                 │
└──────────┘   消息回复   │       ↓          │  Provider  └─────────────────┘
                         │  ProviderRegistry │  接口
                         └─────────────────┘
                                ↓
                         ┌─────────────────┐
                         │  SQLite (bun)    │
                         │  TaskScheduler   │
                         │  Skills System   │
                         └─────────────────┘
```

## 核心模块

### 消息通道 (`src/channels/`)

| 文件 | 说明 |
|------|------|
| `types.ts` | Channel 接口定义：`IncomingMessage`、`ChatInfo`、`Channel` |
| `manager.ts` | `ChannelManager` — 注册多通道、路由消息到正确的通道 |
| `feishu.ts` | `FeishuChannel` — 飞书集成：Webhook 接收消息、发送文本/图片、WebSocket 实时推送 |

### Agent Provider (`src/providers/`)

统一的 Provider 抽象，每个 AI 后端实现 `AgentProvider` 接口：

| 文件 | 说明 |
|------|------|
| `types.ts` | 核心接口：`AgentProvider`、`AgentSession`、`AgentEvent`、`SessionConfig`、`ToolDefinition` |
| `registry.ts` | `ProviderRegistry` — 注册、获取、切换 Provider |
| `claude.ts` | `ClaudeProvider` — Claude Agent SDK，进程内 MCP 工具，完整内置工具支持 |
| `codex.ts` | `CodexProvider` — Codex SDK，wrapper 脚本解决 cwd 问题，全局 MCP server 注册 |
| `kimi.ts` | `KimiProvider` — Kimi Agent SDK，Node.js wrapper 绕过 Bun pipe 兼容性问题 |

### 工具系统 (`src/tools.ts`)

平台无关的工具定义，所有 Provider 共享同一套工具逻辑：

| 工具 | 说明 | 权限 |
|------|------|------|
| `send_message` | 发送文本消息 | 所有群组 |
| `send_image` | 发送图片 | 所有群组 |
| `schedule_task` | 创建定时任务 | 所有群组 |
| `list_tasks` | 查看定时任务 | 所有群组 |
| `pause_task` / `resume_task` / `cancel_task` | 管理定时任务 | 所有群组 |
| `list_curated_skills` / `install_curated_skill` | 技能市场 | 所有群组 |
| `list_groups` | 查看所有群组 | 仅主群 |
| `register_group` | 注册新群组 | 仅主群 |
| `refresh_groups` | 刷新群组元数据 | 仅主群 |
| `switch_provider` | 切换群组 AI 引擎 | 仅主群 |
| `cross_group_schedule_task` | 跨群组创建任务 | 仅主群 |

通过 `MessageSender` 接口抽象消息发送：
- **Claude/Kimi**: 进程内直接调用 `channelManager`
- **Codex**: 通过 HTTP 转发到主进程的内部 API（端口 9800）

### 消息路由 (`src/router.ts`)

- 每 2 秒轮询新消息
- 根据触发条件决定是否激活 agent（主群无需触发，普通群需 @mention 或关键词）
- 消息累积直到触发，所有累积消息作为上下文一起发送

### 并发控制 (`src/group-queue.ts`)

- `GroupQueue` — 每群组串行执行，全局最多 3 个并发 agent
- 支持向活跃 session 推送后续消息（多轮对话）
- 自动处理事件流：文本回复 → 发送到群聊，session ID → 持久化

### 定时任务 (`src/task-scheduler.ts`)

- 基于 cron 表达式的定时任务调度
- 支持两种上下文模式：`isolated`（新 session）和 `group`（复用活跃 session）
- 时区支持（默认 Asia/Shanghai）

### 数据库 (`src/db.ts`)

使用 `bun:sqlite`，包含以下表：

| 表 | 说明 |
|---|------|
| `registered_groups` | 群组注册信息，含 `agent_provider` 字段 |
| `messages` | 消息历史 |
| `sessions` | Agent session ID 持久化（用于恢复对话） |
| `router_state` | 消息路由游标 |
| `scheduled_tasks` | 定时任务配置和状态 |

### MCP Stdio Server (`src/mcp-stdio-server.ts`)

Codex 专用的独立 MCP server 进程：
- 通过 `import.meta.dir` 自动定位项目根目录，不依赖环境变量
- 复用 `tools.ts` 的工具定义，无重复逻辑
- 消息发送通过 HTTP 转发到主进程

## 群组管理

### 自动注册
- 第一个发消息的群 → 自动注册为**主群**（无需触发）
- 后续群 → 注册为**普通群**（需 @mention 触发）

### 群组目录结构
```
groups/
├── main/                    # 主群工作目录
│   ├── CLAUDE.md            # Agent 指令
│   ├── AGENTS.md → CLAUDE.md  # Codex 兼容 symlink
│   └── .claude/skills/      # 已安装的技能
│       └── .agents/skills → ../.claude/skills  # Codex 兼容 symlink
├── feishu_{chatId}/         # 普通群工作目录
│   └── (同上)
├── MAIN_CLAUDE.md           # 主群指令模板
└── GROUP_CLAUDE.md          # 普通群指令模板
```

## 技能系统

```
skills/
├── system/       # 系统技能，自动同步到所有群组
│   ├── agent-browser/
│   └── skill-creator/
└── curated/      # 可选安装的技能
    └── canvas-design/
```

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 | 必填 |
| `MAIN_GROUP_CHAT_ID` | 主群 chat ID | 可选（首条消息自动注册） |
| `ANTHROPIC_API_KEY` | Claude API Key | Claude Provider 需要 |
| `ANTHROPIC_BASE_URL` | Claude API 端点 | 可选 |
| `CODEX_MODEL` | Codex 模型覆盖 | 读取 ~/.codex/config.toml |
| `KIMI_MODEL` | Kimi 模型覆盖 | 读取 ~/.kimi/config.toml |
| `PORT` | Webhook 服务端口 | 3000 |
| `INTERNAL_PORT` | 内部 API 端口 | 9800 |
| `LOG_LEVEL` | 日志级别 | debug |
| `TZ` | 定时任务时区 | Asia/Shanghai |

### 启动

```bash
bun run start
```

## 数据流

```
用户在飞书发消息
  → Feishu Webhook / WebSocket
    → FeishuChannel.handleMessageEvent()
      → insertMessage(db)
      → autoRegisterChat() (如果是新群)

Router 轮询 (每 2 秒)
  → getUnprocessedMessages()
  → shouldTrigger() 检查
  → GroupQueue.enqueue() 或 pushMessage()

GroupQueue
  → ProviderRegistry.get(group.agent_provider)
  → provider.startSession(config)
  → 处理事件流:
      AgentEvent.text → channelManager.send() → 飞书 API
      AgentEvent.result → saveSessionId()
```
