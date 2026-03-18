# 多 Agent Provider 架构

## 概述

Octo 支持多种 AI Agent 后端（Claude Agent SDK、Codex SDK 等），通过 Provider 抽象层统一接口。每个群组可以独立配置使用哪个 Provider。

## 架构

```
消息进入 → Router → GroupQueue → ProviderRegistry.get(group.agent_provider)
                                        ├── ClaudeProvider  → claude-agent-sdk
                                        └── CodexProvider   → @openai/codex-sdk
```

### 核心接口

```typescript
// src/providers/types.ts

interface AgentProvider {
  readonly name: string
  startSession(config: SessionConfig): Promise<{
    session: AgentSession    // push() / close()
    events: AsyncIterable<AgentEvent>  // text / result / error
  }>
}
```

Provider 返回统一的事件流，调用层（GroupQueue）不关心底层是哪个 SDK。

### 文件结构

```
src/
├── providers/
│   ├── types.ts          # AgentProvider, AgentSession, AgentEvent 接口
│   ├── registry.ts       # ProviderRegistry — 注册和获取 Provider
│   ├── claude.ts         # ClaudeProvider — Claude Agent SDK 实现
│   ├── codex.ts          # CodexProvider — Codex SDK 实现
│   └── index.ts          # 统一导出
├── tools.ts              # 平台无关的工具定义 (ToolDefinition[])
├── mcp-stdio-server.ts   # Codex 专用的 stdio MCP server
├── group-queue.ts        # 使用 Provider 启动会话
└── index.ts              # 注册 Provider，启动内部 API
```

## Claude Provider

直接在进程内运行，功能完整：

- 使用 `query()` + AsyncGenerator 流式消息
- 工具通过 `createSdkMcpServer()` 包装为进程内 MCP Server
- 支持 `settingSources: ["project"]`（自动加载 CLAUDE.md）
- 支持内置工具：Read, Edit, Write, Glob, Grep, Bash, Skill
- Session 恢复通过 `resume` option

## Codex Provider

Codex SDK 是 CLI wrapper（spawn `codex exec` 子进程），有几个关键差异需要处理：

### 1. 工作目录 (cwd)

**问题**：SDK 的 `spawn()` 没有设置 `cwd`，导致 `codex exec` 在 octo 根目录启动，无法自动发现 group 目录的 `AGENTS.md` 和 `.agents/skills/`。

**解决**：使用 wrapper 脚本（`store/codex-wrapper.sh`）在启动前 `cd` 到 group 目录。

```sh
# store/codex-wrapper.sh
#!/bin/sh
cd "$CODEX_WORKING_DIR" && exec "$CODEX_REAL_PATH" "$@"
```

通过 `codexPathOverride` 指向 wrapper，`env` 传入 `CODEX_WORKING_DIR` 和 `CODEX_REAL_PATH`。

### 2. 指令文件兼容

**问题**：Claude 读 `CLAUDE.md`，Codex 读 `AGENTS.md`。

**解决**：每个 group 目录自动创建 symlink：
- `AGENTS.md → CLAUDE.md`
- `.agents/skills → ../.claude/skills`

只维护一份 `CLAUDE.md` 和 `.claude/skills/`。

### 3. 自定义工具 (MCP)

**问题**：Claude 支持进程内 MCP Server（`createSdkMcpServer()`），Codex 不支持。Codex 的 MCP server 必须是独立进程，且 Codex CLI **不会**把父进程的环境变量传递给 MCP 子进程。

**解决**：

1. **独立 MCP server** (`src/mcp-stdio-server.ts`)：
   - 通过 `import.meta.dir` 自动定位项目根目录和 SQLite 数据库，不依赖 env
   - 直接操作 SQLite 处理大部分工具
   - `send_message`/`send_image` 通过 HTTP 转发到主进程的内部 API

2. **内部 API**（端口 9800）：
   - `POST /internal/send` — 转发消息到 ChannelManager
   - `POST /internal/send-image` — 转发图片
   - `POST /internal/refresh-groups` — 刷新群组元数据

3. **全局注册**：启动时通过 `codex mcp add` 注册到 `~/.codex/config.toml`

4. **groupFolder 参数化**：MCP server 的工具接受 `groupFolder` 作为参数，由 agent 根据工作目录推断

```
数据流：
Codex agent 调用 schedule_task(groupFolder="feishu_xxx", ...)
  → stdio → mcp-stdio-server.ts
    → SQLite: INSERT INTO scheduled_tasks ...

Codex agent 调用 send_message(chatJid="oc_xxx", text="hello")
  → stdio → mcp-stdio-server.ts
    → HTTP POST → 主进程 :9800/internal/send
      → channelManager.send() → Feishu API
```

### 4. 多轮对话

**问题**：Claude 支持 AsyncGenerator 式消息推送，Codex 使用 `thread.run()` 发起新 turn。

**解决**：CodexProvider 内部维护消息队列，当前 turn 结束后自动发起新 turn。

### 5. 模型和认证

Codex 使用 `~/.codex/config.toml` 的全局配置（model_provider, model 等），不在代码中硬编码。可通过 `CODEX_MODEL` 环境变量覆盖。

## 数据库

`registered_groups` 表包含 `agent_provider` 字段（默认 `'claude'`）：

```sql
ALTER TABLE registered_groups ADD COLUMN agent_provider TEXT DEFAULT 'claude';
```

切换 provider 时自动清除不兼容的 session：

```sql
UPDATE registered_groups SET agent_provider = 'codex' WHERE folder = 'xxx';
DELETE FROM sessions WHERE group_folder = 'xxx';
```

## 切换 Provider

在 main 群组对 agent 说：

> "把 feishu_xxx 群组切换到 codex"

Agent 会调用 `switch_provider` 工具完成切换。

或手动：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_provider = 'codex' WHERE folder = 'xxx';"
```

## 添加新 Provider

1. 创建 `src/providers/xxx.ts`，实现 `AgentProvider` 接口
2. 在 `src/index.ts` 中 `providers.register(new XxxProvider())`
3. 群组设置 `agent_provider = 'xxx'` 即可使用
