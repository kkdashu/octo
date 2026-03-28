# Octo 项目文档

## 概述

Octo 是一个多群组 AI Agent 编排系统，接入飞书群消息，把每个群组映射到独立工作目录与独立 Claude session。当前版本已经把底层运行时统一收敛到 Claude Agent SDK。

## 当前架构

```text
即时通讯平台
  → ChannelManager
    → Router
      → GroupQueue
        → resolveAgentProfile(group.agent_provider)
        → ClaudeProvider
          → Claude Agent SDK
            → Anthropic 直连
            或
            → OpenAIProxyManager
              → OpenAI / 其他 OpenAI 兼容上游
```

## 核心模块

### 通道层

- `src/channels/manager.ts`：多通道管理、消息发送、图片发送
- `src/channels/feishu.ts`：飞书接入

### 运行时

- `src/providers/claude.ts`：唯一 provider，负责启动 Claude SDK session
- `src/runtime/profile-config.ts`：读取 profile 配置，解析 API key / model / baseUrl
- `src/runtime/openai-proxy.ts`：多租户 Anthropic → OpenAI 兼容代理
- `src/runtime/openai-transform.ts`：Anthropic / OpenAI 请求响应转换
- `src/runtime/types.ts`：profile 与 proxy 类型

### 调度与状态

- `src/group-queue.ts`：每群串行、全局并发限制、session 恢复
- `src/router.ts`：触发规则和消息聚合
- `src/task-scheduler.ts`：cron 定时任务
- `src/db.ts`：SQLite 存储

### 工具层

- `src/tools.ts`：统一工具定义
- `src/runtime/minimax-image.ts`：MiniMax 文生图请求、响应解析与图片落盘
- 所有工具都通过 Claude SDK 的进程内 MCP 暴露给 agent
- `generate_image` 会把图片生成到当前群目录 `.generated/images/`，再由 `send_image` 负责发送

## Profile 语义

`registered_groups.agent_provider` 字段已保留，但含义变为 profile key：

- `claude`：Anthropic 直连
- `codex`：OpenAI Responses 兼容线路
- `kimi`：Moonshot Anthropic 兼容直连，endpoint 为 `https://api.moonshot.cn/anthropic`
- `kimi-cli`：Moonshot Coding Plan Anthropic 兼容直连，endpoint 为 `https://api.kimi.com/coding`
- `minimax`：MiniMax Anthropic 兼容直连，endpoint 为 `https://api.minimaxi.com/anthropic`

切换 profile 不再删除 `sessions` 表记录，因为底层 session 已统一为 Claude session。

## 群组目录

```text
groups/
├── main/
│   ├── CLAUDE.md
│   └── .claude/skills/
├── feishu_{chatId}/
│   ├── CLAUDE.md
│   └── .claude/skills/
├── MAIN_CLAUDE.md
└── GROUP_CLAUDE.md
```

只保留 `CLAUDE.md` 与 `.claude/skills`，不再维护 `AGENTS.md` 或 `.agents/skills` 兼容链路。

## 数据流

```text
飞书消息
  → insertMessage(db)
  → Router 轮询触发
  → GroupQueue.enqueue()
  → resolveAgentProfile()
  → ClaudeProvider.startSession()
  → AgentEvent.text/result/error
  → channelManager.send() / saveSessionId()
```

## 环境变量

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- `MAIN_GROUP_CHAT_ID`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `MOONSHOT_API_KEY`
- `MINIMAX_API_KEY`
- `AGENT_PROFILES_PATH`
- `OPENAI_PROXY_PORT`
- `PORT`
- `LOG_LEVEL`
- `TZ`

## 运维说明

- `switch_provider` 现在切的是 profile，不是 SDK
- `list_profiles` 可查看当前 profile 配置
- 如果使用 OpenAI 兼容线路，Claude SDK 实际会连到本地 proxy，再由 proxy 转发到真实上游
- `kimi` / `kimi-cli` 不经过本地 OpenAI proxy
- `minimax` 不经过本地 OpenAI proxy
- `generate_image` 使用 MiniMax 独立图片生成接口，不依赖当前群的 `agent_provider`
