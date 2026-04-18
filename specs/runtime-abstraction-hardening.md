# 收敛 Octo 运行时抽象，去掉假中立 Provider 语义

## 问题描述

当前 `octo` 在 `src/providers/types.ts` 中定义了一套看起来像“多 Provider 可插拔”的接口，但它已经不能真实描述当前系统：

1. **抽象自称中立，字段却已经泄漏 Pi 语义**
   - `resumeSessionId` 实际保存的是 Pi 本地 session 文件引用，不是通用 session id
   - `clearContext()` 吃整份 `SessionConfig`，但 Pi 实现实际只用其中少数字段

2. **生命周期被压扁，不符合 Pi 原生模型**
   - 当前 `startSession()` 同时做了“创建 session”和“立刻发送首条 prompt”
   - Pi 原生把 `createAgentSession()` 和 `session.prompt()/followUp()/steer()` 分得很清楚

3. **会话输入语义过于模糊**
   - 当前只有 `push(text)`，但 Pi 原生区分：
     - `prompt`
     - `followUp`
     - `steer`
   - 现在 `octo` 在适配层里偷偷做策略：streaming 时自动走 `followUp`
   - 这样上层无法表达“排队补充”和“强制转向”之间的区别

4. **事件模型压缩过度**
   - 当前只暴露：
     - `text`
     - `result`
     - `error`
   - 这导致后续如果要做更好的 trace、UI 状态、工具执行态、自动压缩观测，就需要再次改接口

5. **工具契约也是假中立**
   - 当前 `ToolDefinition` 只允许返回文本
   - 但底层 MCP / Pi tool content 实际可以表达更丰富的 block

6. **命名误导**
   - 这层代码真正做的是：
     - Octo 配置 -> Pi session 装配
     - Octo tools -> Pi custom tools
     - 外部 MCP -> Pi extensions
     - Octo session ref -> Pi SessionManager
   - 它更像“运行时适配边界”，而不是“可替换 Provider”

如果继续保留现状，会有两个问题：

- 后续接入更多 channel 时，上层无法显式表达“正常继续 / 排队补充 / 强制转向”这类控制语义
- 后续维护者会继续误以为这里是一个真实的多 Provider 架构，从而不断往错误方向扩展

本轮目标不是删除这层边界，而是把它**收敛成一个诚实、可扩展、与 Pi 原生模型更一致的 runtime contract**。

## 对现有项目的影响

### 一、受影响模块

- `src/providers/types.ts`
- `src/providers/pi.ts`
- `src/providers/index.ts`
- `src/group-queue.ts`
- `src/router.ts`
- `src/task-scheduler.ts`
- `src/tools.ts`
- `tests/providers.test.ts`
- `tests/group-queue.test.ts`
- `tests/group-memory.test.ts`

### 二、边界语义变化

本轮不再把这层称为“通用 Provider 抽象”，而是改成“运行时边界”：

- `AgentProvider` -> `AgentRuntime`
- `AgentSession` -> `RuntimeConversation`
- `SessionConfig` -> 拆成更精确的输入结构

为了控制改动范围，本轮**先不移动目录**：

- 文件仍暂时放在 `src/providers/`
- 但接口与命名改成 runtime 语义

这样可以避免本轮大量机械式目录迁移，把精力集中在契约本身。

### 三、调用方变化

`GroupQueue` 的职责会更清晰：

1. 读取群、profile、session ref、group memory、tools、external MCP
2. 调用 runtime 开一个 conversation
3. 显式发送首条输入
4. 在 active conversation 上显式发送：
   - `prompt`
   - `follow_up`
   - `steer`

这将为未来不同 channel 提供更强的控制能力。

## 实现方案

## 一、把“Provider 接口”改成“Runtime 边界”

当前：

```ts
export interface AgentProvider {
  startSession(config: SessionConfig): Promise<{ session; events }>;
  clearContext(config: SessionConfig): Promise<{ sessionId: string }>;
}
```

建议改为：

```ts
export type RuntimeInputMode = "prompt" | "follow_up" | "steer";

export interface ConversationMessageInput {
  text: string;
  mode: RuntimeInputMode;
}

export interface OpenConversationInput {
  groupFolder: string;
  workingDirectory: string;
  isMain: boolean;
  profile: ResolvedAgentProfile;
  tools: RuntimeToolDefinition[];
  externalMcpServers?: Record<string, ExternalMcpServerSpec>;
  resumeSessionRef?: string;
}

export interface ResetSessionInput {
  groupFolder: string;
  workingDirectory: string;
  profile: ResolvedAgentProfile;
  resumeSessionRef?: string;
}

export interface RuntimeConversation {
  send(input: ConversationMessageInput): Promise<void>;
  close(): void;
}

export interface AgentRuntime {
  readonly name: string;

  openConversation(input: OpenConversationInput): Promise<{
    conversation: RuntimeConversation;
    events: AsyncIterable<RuntimeEvent>;
  }>;

  resetSession(input: ResetSessionInput): Promise<{
    sessionRef: string;
  }>;
}
```

### 设计理由

1. `resumeSessionRef` 命名与当前真实数据模型一致
2. `openConversation()` 只负责“开会话”，不再隐式发送首条输入
3. `send()` 显式暴露 `prompt / follow_up / steer`
4. `resetSession()` 单独定义输入，避免过宽契约

## 二、把事件模型从“最小可用”升级为“可扩展”

当前：

```ts
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "result"; sessionId?: string }
  | { type: "error"; error: Error };
```

建议改为：

```ts
export type RuntimeDiagnosticName =
  | "turn_start"
  | "turn_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "auto_retry_start"
  | "auto_retry_end";

export type RuntimeEvent =
  | { type: "assistant_text"; text: string }
  | { type: "completed"; sessionRef?: string }
  | { type: "failed"; error: Error }
  | {
      type: "diagnostic";
      name: RuntimeDiagnosticName;
      message?: string;
    };
```

### 设计理由

1. `assistant_text / completed / failed` 比 `text / result / error` 语义更清晰
2. 先引入最小诊断事件集合，给后续 UI / trace / 调试留扩展点
3. `GroupQueue` 本轮可以先忽略 `diagnostic`，但 runtime contract 不再被压死

## 三、把首条输入从 open 动作中拆出去

当前 `PiProvider.startSession()` 在内部直接：

```ts
await session.prompt(initialPrompt);
```

建议改成：

1. `openConversation()` 只装配 Pi session 和事件桥接
2. `GroupQueue` 在 `openConversation()` 成功后，显式调用：

```ts
await conversation.send({
  mode: "prompt",
  text: initialPromptWithMemory,
});
```

### 设计理由

1. 生命周期清晰：open 是 open，send 是 send
2. 更接近 Pi 原生模型
3. 未来如果某些 channel 或控制流想“先开会话，再决定发什么输入”，接口已经支持

## 四、把 `push()` 改成显式输入模式

当前：

```ts
interface AgentSession {
  push(text: string): void;
  close(): void;
}
```

建议改成：

```ts
interface RuntimeConversation {
  send(input: ConversationMessageInput): Promise<void>;
  close(): void;
}
```

Pi 适配层映射规则：

- `mode = "prompt"` -> `session.prompt(text)`
- `mode = "follow_up"` -> `session.followUp(text)`
- `mode = "steer"` -> `session.steer(text)`

### GroupQueue 调整

当前 `GroupQueue.pushMessage(groupFolder, text)` 建议改为：

```ts
pushMessage(
  groupFolder: string,
  input: ConversationMessageInput,
): boolean
```

本轮默认调用策略：

- router 上 active session 的后续消息：`follow_up`
- scheduler 的 active session 任务注入：`follow_up`
- future channel 若要“打断改向”，可显式传 `steer`

## 五、工具契约放宽，但不强制平台工具立刻用上全部能力

当前：

```ts
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}
```

建议改为：

```ts
export type RuntimeToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; uri: string; text?: string; mimeType?: string }
  | { type: "resource_link"; name: string; uri: string; description?: string };

export interface RuntimeToolResult {
  content: RuntimeToolContent[];
}
```

### 设计理由

1. 这更接近 MCP / Pi 实际 content 模型
2. 现有平台工具仍然可以只返回 text
3. 以后若某些 tool 或 channel 要返回 richer content，不需要再推翻接口

## 六、Pi 适配层怎么实现

`src/providers/pi.ts` 本轮职责重组为：

1. `openConversation()`
   - 创建 `SessionManager`
   - 建 `ModelRegistry`
   - 建 `DefaultResourceLoader`
   - 建 Pi MCP extension bundle
   - 建 Pi session
   - 订阅 Pi event
   - 映射到 `RuntimeEvent`
   - 返回 `RuntimeConversation`

2. `RuntimeConversation.send()`
   - 先调用 `normalizePromptForAgent()`
   - 再根据 `mode` 映射到 Pi：
     - `prompt`
     - `followUp`
     - `steer`

3. `resetSession()`
   - 只负责 fresh session ref 的创建
   - 返回 `sessionRef`

### 事件映射策略

- Pi `message_end` -> `assistant_text`
- 首轮或任意一次 send 成功完成 -> `completed`
- Pi error -> `failed`
- Pi 的 auto-compaction / retry / turn lifecycle -> `diagnostic`

`GroupQueue` 本轮只消费：

- `assistant_text`
- `completed`
- `failed`

但不丢弃 `diagnostic` 这个接口能力。

## 七、调用方调整

### `src/group-queue.ts`

改动点：

1. `provider` 字段改为 `runtime`
2. `startSession()` -> `openConversation()`
3. session open 成功后，再显式 `conversation.send({ mode: "prompt", text: ... })`
4. `pushMessage()` 改成接收 `ConversationMessageInput`
5. `clearSession()` 改用 `resetSession()`
6. `result.sessionId` -> `completed.sessionRef`
7. `resumeSessionId` -> `resumeSessionRef`

### `src/router.ts`

当前 active session follow-up 行为改成显式：

```ts
groupQueue.pushMessage(group.folder, {
  mode: "follow_up",
  text: prompt,
});
```

### `src/task-scheduler.ts`

当前 active session follow-up 行为改成显式：

```ts
groupQueue.pushMessage(task.group_folder, {
  mode: "follow_up",
  text: prompt,
});
```

## 八、测试策略

需要更新：

- `tests/providers.test.ts`
  - 契约改成 `AgentRuntime`
  - 补 `steer / follow_up / prompt` 映射测试
  - 补 `openConversation` 不再隐式发送首条 prompt 的测试

- `tests/group-queue.test.ts`
  - 校验 `resumeSessionRef`
  - 校验初始输入由 queue 显式发送
  - 校验 active session follow-up 模式
  - 增加 `steer` 路径测试（至少 runtime mock 级别）

- `tests/group-memory.test.ts`
  - 更新 runtime mock
  - 校验 `resetSession()` 新契约

## 实施边界与非目标

本轮会做：

- 收敛 runtime 接口
- 让会话输入支持 `prompt / follow_up / steer`
- 让 session ref、event、tool result 命名与模型更诚实

本轮不做：

- 不重写 channel 抽象
- 不迁移目录 `src/providers -> src/runtime`，避免过多机械改名
- 不把所有诊断事件都接入 UI，仅先定义 contract 与 Pi 适配输出
- 不重做 admin UI

## Todo List

### Phase 0: 方案确认
- [x] 确认本轮保留边界层，但从“Provider 抽象”收敛为“Runtime 边界”
- [x] 确认本轮显式支持 `prompt / follow_up / steer`
- [x] 确认本轮先不移动 `src/providers/` 目录，只调整接口与实现

### Phase 1: Runtime 契约重构
- [x] 修改 `src/providers/types.ts`，将 `AgentProvider` 改为 runtime 语义
- [x] 将 `SessionConfig` 拆分为 `OpenConversationInput` / `ResetSessionInput`
- [x] 将 `resumeSessionId` 改为 `resumeSessionRef`
- [x] 将 `AgentSession.push()` 改为显式 `send({ mode, text })`
- [x] 将事件模型改为 `assistant_text / completed / failed / diagnostic`
- [x] 放宽 `ToolDefinition` 的返回 content 类型

### Phase 2: Pi 适配层重构
- [x] 修改 `src/providers/pi.ts`，将 `startSession()` 改为 `openConversation()`
- [x] 去掉 `openConversation()` 中隐式发送首条 prompt 的逻辑
- [x] 在 `RuntimeConversation.send()` 中显式映射 `prompt / follow_up / steer`
- [x] 修改 `src/providers/pi.ts` 的事件桥接逻辑
- [x] 修改 `src/providers/pi.ts`，将 `clearContext()` 改为 `resetSession()`
- [x] 更新 `src/providers/index.ts`

### Phase 3: 上层调用方迁移
- [x] 修改 `src/group-queue.ts` 使用新的 runtime 接口
- [x] 修改 `src/group-queue.ts`，在 open 后显式发送首条 prompt
- [x] 修改 `src/group-queue.ts`，follow-up 行为改成显式 mode
- [x] 修改 `src/router.ts`，active session follow-up 使用新输入结构
- [x] 修改 `src/task-scheduler.ts`，active session follow-up 使用新输入结构

### Phase 4: 测试与验证
- [x] 更新 `tests/providers.test.ts`
- [x] 更新 `tests/group-queue.test.ts`
- [x] 更新 `tests/group-memory.test.ts`
- [x] 运行相关测试并修正失败
- [x] 运行 `bun test tests/*.test.ts`
