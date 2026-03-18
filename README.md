# Octo

多群组 AI Agent 编排系统 — 连接即时通讯平台与多种 AI 后端，让每个群组拥有独立的智能助手。

## 特性

- **多 Provider 架构** — 同时支持 Claude、Codex、Kimi 三种 AI 引擎，每个群组可独立切换，统一的 Provider 接口让新增后端只需一个文件
- **多群组隔离** — 每个群组独立工作目录、独立会话、独立技能配置，互不干扰
- **统一工具系统** — 消息发送、图片发送、定时任务、技能安装等工具，一份代码所有 Provider 共用
- **即时通讯集成** — 飞书原生支持（Webhook + WebSocket），Channel 抽象可扩展到 Slack、Discord 等
- **定时任务** — 基于 cron 表达式的任务调度，支持隔离和共享上下文两种模式
- **技能市场** — 系统技能自动同步，可选技能按需安装，跨 Provider 兼容
- **会话恢复** — Agent 会话自动持久化，重启后可继续对话

## 架构

```
飞书群消息 → Channel → Router → GroupQueue → Provider → AI Agent
                                                ├── Claude (claude-agent-sdk)
                                                ├── Codex  (@openai/codex-sdk)
                                                └── Kimi   (kimi-agent-sdk)
```

Provider 返回统一的事件流（`text` / `result` / `error`），上层完全不感知底层 SDK 差异。

## 快速开始

```bash
# 安装依赖
bun install

# 配置环境变量
cp env.example .env
# 编辑 .env 填入飞书应用凭证和 API Key

# 启动
bun run start
```

## 切换 AI 引擎

在主群对 Octo 说：

> "把 xxx 群组切换到 codex"

或直接操作数据库：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_provider = 'kimi' WHERE folder = 'xxx';"
```

## 添加新 Provider

1. 创建 `src/providers/xxx.ts`，实现 `AgentProvider` 接口
2. 在 `src/index.ts` 中注册 `providers.register(new XxxProvider())`
3. 群组设置 `agent_provider = 'xxx'` 即可使用

```typescript
interface AgentProvider {
  readonly name: string
  startSession(config: SessionConfig): Promise<{
    session: AgentSession       // push() / close()
    events: AsyncIterable<AgentEvent>  // text / result / error
  }>
}
```

## 技术栈

- **Runtime**: Bun
- **Database**: SQLite (bun:sqlite)
- **AI SDKs**: Claude Agent SDK, Codex SDK, Kimi Agent SDK
- **IM**: 飞书 (Lark)
- **Protocol**: MCP (Model Context Protocol)

## 文档

- [项目详细文档](docs/octo.md)
- [多 Provider 架构设计](docs/multi-agent-provider.md)

## License

MIT
