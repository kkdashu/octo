# Octo

多群组 AI Agent 编排系统。现在底层统一只使用 Claude Agent SDK，群组间通过 `agent_provider` 选择不同的模型线路 profile，而不是切换不同 SDK。

## 特性

- 统一 runtime：所有群组都走 `ClaudeProvider`
- 多 profile 路由：`claude`、`codex`、`kimi`、`kimi-cli`
- 多群隔离：独立工作目录、独立 session、独立技能
- 统一工具：全部通过 Claude SDK 进程内 MCP 接入
- 会话恢复：群组切换 profile 不再清 session
- 定时任务与技能安装：沿用现有工具体系

## 架构

```text
飞书群消息
  → Channel / Router
    → GroupQueue
      → resolveAgentProfile(group.agent_provider)
      → ClaudeProvider
        → Claude Agent SDK
          → Anthropic 直连
          或
          → 本地 OpenAI 兼容 proxy
            → OpenAI / 其他 OpenAI 兼容上游
```

## 快速开始

```bash
bun install
cp env.example .env
# 编辑 .env，填入飞书凭证和各线路 API Key

bun run start
```

默认会读取：

1. `AGENT_PROFILES_PATH` 指向的配置文件
2. 若未设置，则尝试 `config/agent-profiles.json`
3. 若仍不存在，则回退到 `config/agent-profiles.example.json`

Moonshot/Kimi 线路说明：

- `kimi`：走 `https://api.moonshot.cn/anthropic`
- `kimi-cli`：走 `https://api.kimi.com/coding`
- 这两条线路都以 Anthropic 兼容模式直连 Claude Agent SDK，不经过本地 OpenAI 兼容 proxy
- 本地 OpenAI 兼容 proxy 只用于真正的 OpenAI 格式 profile，例如 `codex`

## 切换线路

在主群里使用：

- `list_profiles`：查看当前可用 profile
- `switch_provider`：把目标群切到指定 profile

或直接修改数据库：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_provider = 'kimi-cli' WHERE folder = 'xxx';"
```

这里的 `agent_provider` 现在表示 profile key，不再表示底层 SDK 类型。

## 配置文件

示例见 [config/agent-profiles.example.json](/Users/wmeng/work/kkdashu/octo/config/agent-profiles.example.json)。

```json
{
  "defaultProfile": "claude",
  "profiles": {
    "claude": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "model": "claude-sonnet-4-6"
    },
    "codex": {
      "apiFormat": "openai",
      "upstreamApi": "responses",
      "baseUrl": "https://api.openai.com",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4"
    },
    "kimi": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.moonshot.cn/anthropic",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5",
      "provider": "moonshot"
    },
    "kimi-cli": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.kimi.com/coding",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5",
      "codingPlanEnabled": true,
      "provider": "moonshot"
    }
  }
}
```

## 技术栈

- Runtime: Bun
- Database: SQLite (`bun:sqlite`)
- Agent runtime: `@anthropic-ai/claude-agent-sdk`
- IM: 飞书
- Validation: `zod`

## 文档

- [项目文档](/Users/wmeng/work/kkdashu/octo/docs/octo.md)
- [统一运行时说明](/Users/wmeng/work/kkdashu/octo/docs/multi-agent-provider.md)
