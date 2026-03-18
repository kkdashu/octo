# 多 Agent 后端支持

## 问题描述

当前系统的 `agent.ts` 与 Claude Agent SDK 高度耦合。`runGroupAgent()` 直接调用 `query()`，`MessageChannel` 绑定了 `SDKUserMessage` 类型，`agent-tools.ts` 使用 `createSdkMcpServer()` 创建工具。

需要支持多种 Agent 后端（Claude Agent SDK、Codex SDK、未来的 kimi-cli 等），让每个群组可以配置使用不同的 Agent 提供者。

## 对现有项目的影响

### 需要修改的文件
- `src/agent.ts` → 拆分为 Provider 接口 + Claude 实现
- `src/agent-tools.ts` → 工具定义与 SDK 解耦
- `src/group-queue.ts` → 使用抽象的 `AgentSession` 替代 `MessageChannel`
- `src/db.ts` → 新增 `agent_provider` 字段
- `src/index.ts` → 初始化 Provider 注册表
- `src/router.ts` → 无需修改（不直接接触 agent）

### 需要新建的文件
- `src/providers/types.ts` → Provider 接口定义
- `src/providers/claude.ts` → Claude Agent SDK 实现
- `src/providers/codex.ts` → Codex SDK 实现
- `src/providers/registry.ts` → Provider 注册与管理
- `src/tools.ts` → 平台无关的工具定义

## 架构设计

### 核心接口

```typescript
// src/providers/types.ts

/** Agent 会话事件流 — 统一不同 SDK 的输出格式 */
type AgentEvent =
  | { type: "text"; text: string }         // 可发送给用户的文本
  | { type: "result"; sessionId?: string } // 会话结束
  | { type: "error"; error: Error }        // 错误

/** Agent 会话 — 对一次 agent 执行的抽象 */
interface AgentSession {
  /** 推送后续消息（多轮对话） */
  push(text: string): void
  /** 关闭会话 */
  close(): void
}

/** Agent 提供者 — 不同后端的统一接口 */
interface AgentProvider {
  readonly name: string

  /** 启动新会话，返回会话对象和事件流 */
  startSession(config: SessionConfig): Promise<{
    session: AgentSession
    events: AsyncIterable<AgentEvent>
  }>
}

interface SessionConfig {
  groupFolder: string
  workingDirectory: string
  initialPrompt: string
  isMain: boolean
  resumeSessionId?: string  // 用于恢复会话
  tools: ToolDefinition[]   // 平台无关的工具定义
}
```

### 工具定义抽象

当前工具通过 `createSdkMcpServer()` 绑定到 Claude SDK。需要提取为平台无关的定义，再由各 Provider 适配。

```typescript
// src/tools.ts

interface ToolDefinition {
  name: string
  description: string
  schema: Record<string, any>  // JSON Schema（从 zod 转换）
  handler: (args: any) => Promise<ToolResult>
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>
}
```

各 Provider 的工具适配方式：
- **Claude**: 用 `createSdkMcpServer()` 包装为 MCP Server
- **Codex**: 通过 `--mcp-config` 配置 MCP 服务，或通过 stdio 方式启动独立 MCP server 进程

### Provider 注册表

```typescript
// src/providers/registry.ts

class ProviderRegistry {
  private providers = new Map<string, AgentProvider>()

  register(provider: AgentProvider): void
  get(name: string): AgentProvider | undefined
  getDefault(): AgentProvider
}
```

### 数据库变更

`registered_groups` 表新增字段：

```sql
ALTER TABLE registered_groups ADD COLUMN agent_provider TEXT DEFAULT 'claude';
```

### 消息流对比

**Claude Agent SDK:**
```
query({ prompt: AsyncGenerator<SDKUserMessage> })
  → AsyncIterable<message>
    → message.type === "assistant" → 提取 text blocks
    → message.type === "result"   → 保存 session_id
```

**Codex SDK:**
```
thread.runStreamed(prompt)
  → AsyncIterable<ThreadEvent>
    → event.type === "item.completed" + item.type === "agent_message" → 提取 text
    → event.type === "turn.completed" → 会话结束
```

两者都能被归一化为 `AsyncIterable<AgentEvent>`。

### Claude Provider 实现要点

将现有 `agent.ts` 的逻辑移入 `src/providers/claude.ts`：
- `MessageChannel` + `query()` 包装为 `AgentSession` + `AsyncIterable<AgentEvent>`
- 工具通过 `createSdkMcpServer()` 适配
- Session 恢复通过 `resume` option

### Codex Provider 实现要点

```typescript
// src/providers/codex.ts

import { Codex } from "@openai/codex-sdk"

class CodexProvider implements AgentProvider {
  name = "codex"
  private client: Codex

  async startSession(config: SessionConfig) {
    const thread = config.resumeSessionId
      ? this.client.resumeThread(config.resumeSessionId, threadOpts)
      : this.client.startThread(threadOpts)

    // 启动 MCP server 进程供 Codex 使用（工具集成）
    // 或将工具描述注入 system prompt

    // 将 Codex 事件流转换为 AgentEvent
    const { events: codexEvents } = await thread.runStreamed(config.initialPrompt)

    async function* normalizeEvents() {
      for await (const event of codexEvents) {
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          yield { type: "text" as const, text: event.item.text }
        }
        if (event.type === "turn.completed") {
          yield { type: "result" as const, sessionId: thread.id ?? undefined }
        }
      }
    }

    return {
      session: { push: ..., close: ... },  // Codex 的多轮通过再次 run() 实现
      events: normalizeEvents()
    }
  }
}
```

**Codex 的多轮对话差异：** Codex 不支持 AsyncGenerator 式的消息推送，而是通过 `thread.run()` 发起新 turn。`push()` 方法需要缓存消息，在当前 turn 结束后发起新 turn。

### group-queue.ts 改造

```typescript
// 改造前
private activeChannels: Map<string, MessageChannel> = new Map()

// 改造后
private activeSessions: Map<string, AgentSession> = new Map()
```

`enqueue()` 从直接调用 `runGroupAgent()` 改为：
1. 根据 group 的 `agent_provider` 字段获取对应 Provider
2. 构造 `SessionConfig`（含工具定义）
3. 调用 `provider.startSession(config)`
4. 处理事件流（发送消息、保存 session）

## Todo List

### Phase 1: 定义抽象层
- [x] 创建 `src/providers/types.ts` — Provider 接口、AgentSession 接口、AgentEvent 类型、SessionConfig
- [x] 创建 `src/tools.ts` — 平台无关的 ToolDefinition 接口及工具创建函数（从 `agent-tools.ts` 提取逻辑，不依赖 Claude SDK）
- [x] 创建 `src/providers/registry.ts` — ProviderRegistry 类

### Phase 2: 实现 Claude Provider
- [x] 创建 `src/providers/claude.ts` — 将 `agent.ts` 中的 `runGroupAgent()`、`MessageChannel` 封装为 `ClaudeProvider`
- [x] `ClaudeProvider` 中适配工具：将 `ToolDefinition[]` 转换为 `createSdkMcpServer()` 格式
- [x] 验证 Claude Provider 与现有行为完全一致

### Phase 3: 改造调用层
- [x] 修改 `src/group-queue.ts` — 使用 `AgentSession` 替代 `MessageChannel`，通过 Provider 启动会话
- [x] 修改 `src/db.ts` — `registered_groups` 表增加 `agent_provider` 字段
- [x] 修改 `src/index.ts` — 初始化 ProviderRegistry，注册 Claude Provider，传入 GroupQueue
- [x] 删除旧的 `src/agent.ts`（逻辑已迁入 `src/providers/claude.ts`）
- [x] 删除旧的 `src/agent-tools.ts`（逻辑已迁入 `src/tools.ts` + 各 provider 适配层）

### Phase 4: 实现 Codex Provider
- [x] 创建 `src/providers/codex.ts` — 实现 `CodexProvider`
- [x] Codex 工具集成：当前 Codex 使用自身内置工具（命令执行、文件修改），自定义 MCP 工具后续增量支持
- [x] Codex 多轮对话：处理 `push()` 语义差异（缓存消息，turn 结束后发起新 run）
- [x] Codex session 恢复：使用 `resumeThread()`

### Phase 5: 测试验证
- [x] 编写 Provider 接口的单元测试
- [x] 编写 Provider 接口合规测试（ClaudeProvider、CodexProvider）
- [x] 编写 Mock Provider 事件流测试
- [x] 编写工具定义测试
