# Octo 项目文档

## 概述

Octo 当前的一等模型是 `Workspace / Chat / Run`。外部入口例如飞书群、CLI、desktop 会先绑定到 Workspace 与 Chat，再进入统一的 Pi runtime。当前底层运行时通过 `GroupRuntimeManager`、`FeishuGroupAdapter` 与 `createPiGroupRuntimeFactory()` 统一装配。

## 当前架构

```text
即时通讯平台 / CLI / Desktop
  → ChannelManager / Sidecar API
    → Router / GroupRuntimeManager / FeishuGroupAdapter
      → resolveAgentProfile(workspace.profile_key)
        → createPiGroupRuntimeFactory() / createPiGroupSessionHost()
          → pi-coding-agent runtime
            → builtin tools
            → workspace tools
            → Pi MCP extensions
```

## 核心模块

### 通道层

- `src/channels/manager.ts`：多通道管理、消息发送、图片发送
- `src/channels/feishu.ts`：飞书接入

### 运行时

- `src/runtime/pi-group-runtime-factory.ts`：创建 Pi runtime、session host、ModelRegistry 与工具注入链路
- `src/providers/pi-session-ref.ts`：本地 session ref 管理
- `src/providers/pi-tool-adapter.ts`：把 Octo tools 适配成 Pi custom tools
- `src/providers/pi-mcp-extension.ts`：把外部 MCP server 适配成 Pi extensions
- `src/providers/prompt-normalizer.ts`：规范化 prompt，并接入图片预处理
- `src/runtime/profile-config.ts`：读取 profile 配置并解析默认 profile
- `src/runtime/external-mcp-config.ts`：读取外部 MCP 配置
- `src/runtime/runtime-input-preprocessor.ts`：统一各入口的 prompt 预处理边界
- `src/runtime/image-message-preprocessor.ts`：图片消息预处理与缓存
- `src/runtime/minimax-token-plan-mcp.ts`：调用 MiniMax 图片理解能力
- `src/runtime/async-semaphore.ts`：飞书入口的全局并发门控
- `src/runtime/run-lifecycle.ts`：共享 run 落库、`session_ref` 持久化和 branch 对齐原语

### 调度与状态

- `src/kernel/group-runtime-manager.ts`：Chat 级 runtime、run、branch 管理
- `src/runtime/feishu-group-adapter.ts`：Workspace 串行与飞书入口协同
- `src/router.ts`：触发规则与消息聚合
- `src/task-scheduler.ts`：cron 定时任务
- `src/db.ts`：SQLite 存储

### 工具层

- `src/tools.ts`：统一定义 Workspace / Chat 语义工具
- `src/runtime/minimax-image.ts`：MiniMax 文生图
- 所有业务工具都通过 Pi custom tools 暴露给 agent

### 管理后台

- `src/desktop/api.ts`：desktop sidecar runtime API
- `src/desktop/admin-api.ts`：admin API
- `src/desktop/server.ts`：desktop sidecar HTTP server
- `desktop/src/`：desktop 前端

## 数据模型

Pi-native 重构后，关键字段语义如下：

- `workspaces.profile_key`：Workspace 模型线路
- `chats.session_ref`：Chat 对应的 Pi 本地 session 文件引用
- `workspace_memories`：Workspace 长期记忆
- `runs` / `run_events`：Chat 级运行记录与事件流

与旧架构相比：

- 不再使用 `agent_provider`
- 不再使用 `session_id`
- 切 profile 不会自动删除 session

## Workspace 目录

```text
workspaces/
├── main/
│   ├── AGENTS.md
│   └── .pi/
│       ├── skills/
│       └── sessions/
├── feishu_{appId}/
│   ├── AGENTS.md
│   └── .pi/
│       ├── skills/
│       └── sessions/
```

启动时如果发现旧目录结构，会自动做一次复制迁移：

- `CLAUDE.md` → `AGENTS.md`
- `.claude/skills` → `.pi/skills`

运行时只读取新路径。

## 请求流

```text
飞书消息
  → insertInboundMessage(db)
  → Router / FeishuGroupAdapter
  → 读取 workspace.profile_key 与 chat.session_ref
  → createPiGroupSessionHost()
  → normalizePromptForAgent()
  → buildWorkspaceMemoryAppendSystemPrompt()
  → pi runtime events
  → channelManager.send()
  → updateChat(session_ref)
```

## 运行时边界补充

### 统一输入预处理

- 飞书 / CLI / Desktop 现在都会在 runtime 入场前先经过 `runtime-input-preprocessor`
- 这一层统一负责：
  - legacy 图片语法归一化
  - 图片理解文本注入
  - 本地文件链接和裸路径标注
  - working directory 解析
- 因此相同输入在不同入口下会得到一致的 agent 视图

### 飞书并发模型

- `FeishuGroupAdapter` 继续通过 workspace 级 lock 保证同一 Workspace 串行
- 全局并发上限改由 `AsyncSemaphore` 控制，不再依赖忙等轮询
- 这保证了：
  - workspace 内不会并发跑多个 turn
  - 不同 workspace 之间的全局并发不会突破上限

### Idle runtime 回收

- `GroupRuntimeManager` 会依据 `workspace_runtime_state.unload_after` 判断是否可以卸载 runtime
- 当前仅 desktop sidecar 启动后台 prune loop，CLI 不会自动回收
- 允许回收的前提：
  - 没有 active run
  - runtime 不在 streaming
  - 没有待处理 follow-up / steering
  - 没有活跃 UI 监听器

### 共享 run 生命周期

- `run-lifecycle` 抽取了两条编排链共享的落库原语：
  - run 开始 / 结束
  - `turn_requests` 状态推进
  - `session_ref` 持久化
  - workspace branch 对齐
- 这减少了 `GroupRuntimeManager` 与 `FeishuGroupAdapter` 之间的状态语义漂移

## Profile 路由

`profile_key` 只决定模型线路和上游接口，底层运行时始终是 Pi。

`src/runtime/profile-config.ts` 负责：

- 加载配置文件
- 回退到 `defaultProfile`
- 解析 API key
- 修正 Moonshot 兼容 endpoint

主 Workspace 可通过以下工具运维：

- `list_workspaces`
- `refresh_chats`
- `list_profiles`
- `switch_profile`
- `schedule_workspace_task`
- `clear_session`

## Workspace 记忆

- 长期记忆存储在 SQLite `workspace_memories` 表
- 支持 builtin key：`topic_context`、`response_language`、`response_style`、`interaction_rule`
- 也支持 custom key，但 key 只能使用小写字母和下划线
- 普通 Workspace 只能管理自己的 memory；主 Workspace 可以跨 Workspace 管理
- 记忆只在新 session 启动时注入，避免对 active session 做热更新
- 定时任务与交互式会话复用同一套 Workspace memory 注入逻辑

## 技能与外部 MCP

- system skills 与 curated skills 都安装到 `.pi/skills/`
- `list_curated_skills` / `install_curated_skill` 用于按 Workspace 安装技能
- 外部 MCP 由 `config/external-mcp*.json` 描述
- runtime 启动时通过 `createPiMcpExtensionBundle()` 把已启用 MCP server 转成 Pi extensions 注入

当前的一个典型 gate 例子是 `pdf-to-markdown`：

- Workspace 目录存在 `.pi/skills/pdf-to-markdown/SKILL.md`
- 对应 `markitdown` MCP server 才会被启用

## 图片处理

- 飞书收到的图片仍按 `media/<chatId>/<messageId>.<ext>` 落盘
- 主模型不直接读原始图片路径，而是先走统一图片理解
- 图片理解结果以纯文本块注入 prompt
- 缓存键为 `sha256(file bytes) + prompt_version`
- 若图片理解失败，会降级成失败说明文本，不阻断整条消息

## 环境变量

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `MAIN_GROUP_CHAT_ID`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `MOONSHOT_API_KEY`
- `MINIMAX_API_KEY`
- `MINIMAX_API_HOST`
- `MINIMAX_MCP_COMMAND`
- `AGENT_PROFILES_PATH`
- `EXTERNAL_MCP_CONFIG_PATH`
- `PORT`
- `LOG_LEVEL`
- `TZ`

## 运维说明

- 切线路用 `switch_profile`
- 重置 AI 上下文用 `clear_session`
- 新 Workspace 默认 profile 来自 `defaultProfile`
- 排查单 Workspace 问题时，直接进入对应 `workspaces/<folder>/` 查看 `AGENTS.md`、`.pi/skills/` 和 `.pi/sessions/`
