# 统一 Claude Runtime 与多 Profile 路由

## 背景

Octo 以前同时维护 Claude、Codex、Kimi 三套 SDK 链路，工作目录识别、工具接入、session 恢复方式都不同，导致切换成本和维护成本都很高。

现在已经统一为：

- 底层只保留 Claude Agent SDK
- `agent_provider` 只表示 profile key
- 只有真正的 OpenAI 格式线路通过本地兼容 proxy 接入
- Moonshot/Kimi 线路按 Anthropic 兼容 endpoint 直连

## 主链路

```text
消息进入
  → GroupQueue
    → resolveAgentProfile(group.agent_provider)
    → ClaudeProvider.startSession()
      → Claude Agent SDK query()
        → anthropic profile: 直连 Anthropic / Moonshot Anthropic 兼容上游
        → openai profile: 走 OpenAIProxyManager
```

## Profile 配置

配置文件示例：

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
      "model": "gpt-5.4",
      "provider": "openai"
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
    },
    "minimax": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "model": "MiniMax-M2.7",
      "provider": "minimax"
    }
  }
}
```

`src/runtime/profile-config.ts` 会把它解析成 `ResolvedAgentProfile`，并负责：

- fallback 到 `defaultProfile`
- 校验 profile 是否存在
- 从 `apiKeyEnv` 读取真实密钥
- 按 provider 兼容规则修正真实 endpoint
- 生成 Claude SDK 需要的 `ANTHROPIC_*` 环境变量

其中 Moonshot/Kimi 会按 `mini_cowork` 的已验证行为解析：

- `kimi` → `https://api.moonshot.cn/anthropic`
- `kimi-cli` → `https://api.kimi.com/coding`
- 两者都保持 `apiFormat = "anthropic"`

MiniMax 线路按官方 Anthropic 兼容文档接入：

- `minimax` → `https://api.minimaxi.com/anthropic`
- 保持 `apiFormat = "anthropic"`
- 不经过本地 OpenAI proxy

## OpenAI 兼容 Proxy

`src/runtime/openai-proxy.ts` 参考了 `mini_cowork/src/proxy.ts`，但做了关键调整：

- 只启动一个 HTTP server
- 每个 session 调用 `acquire()` 时分配独立 `routeId`
- route URL 形如 `http://127.0.0.1:<port>/proxy/<routeId>`
- 每条 route 绑定一份独立 upstream 配置
- session 结束后调用 `release()` 释放 route

这样可以避免多个群并发时共享同一个 upstream 配置而串线。

## Session 语义

`registered_groups.agent_provider` 保留原字段名，但含义变为 profile key。  
`updateGroupProvider()` 切 profile 时不再删除 `sessions` 表记录。

这意味着：

- 同一群切换 `claude` / `codex` / `kimi` / `minimax` 后仍可恢复同一 Claude session
- 如果需要重置上下文，应该做显式工具，而不是隐式删 session

## 工具与目录

- 所有工具统一通过 Claude SDK 的进程内 MCP 暴露
- 只保留 `CLAUDE.md` 和 `.claude/skills`
- 不再生成 `AGENTS.md`、`.agents/skills`
- 不再需要 `src/mcp-stdio-server.ts` 和 `/internal/*` API

## 管理工具

- `switch_provider`：切换目标群的 profile key
- `list_profiles`：列出当前配置里的 profile、模型、apiFormat、upstreamApi

其中 `minimax` 会作为新的可选 profile key 暴露给管理后台和工具层。

## 删除的旧链路

- `src/providers/codex.ts`
- `src/providers/kimi.ts`
- `src/providers/registry.ts`
- `src/mcp-stdio-server.ts`

运行时已经不再依赖这些文件。
