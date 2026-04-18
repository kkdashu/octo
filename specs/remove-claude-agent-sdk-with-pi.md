# 使用 Pi Coding Agent 彻底替换 Claude Agent SDK

## 问题描述

当前 `octo` 的 Agent 运行时虽然已经被抽象成 provider 接口，但真实执行路径仍然高度绑定 `@anthropic-ai/claude-agent-sdk`：

- `src/providers/claude.ts` 直接依赖 Claude SDK 的 `query()`、`resume`、`/clear`、MCP server 注册和工具白名单。
- `src/group-queue.ts` 依赖 Claude 的远端 `session_id` 持久化与 `listSessions()` 校验。
- `src/index.ts` 启动了只为 Claude SDK 服务的 OpenAI/Anthropic 代理层。
- 群组工作目录中的 `CLAUDE.md`、`.claude/skills`、MCP 工具命名都与 Claude 语义绑定。

本次需求的目标不是“继续兼容 Claude 语义，只是换个 SDK”，而是：

1. **彻底删除 `@anthropic-ai/claude-agent-sdk` 依赖与相关代码路径**
2. **改用 `pi-coding-agent` 作为唯一 Agent runtime**
3. **允许旧 Claude session 全部失效，不兼容之前的远端 session 恢复方案**
4. **保留现有业务层能力**：
   - 群组排队与并发控制
   - 管理后台的 profile 配置
   - `octo` 自己的工具集
   - 通过技能开关启用外部 MCP（例如 `markitdown`）

本次改造的非目标：

- 不在本期把所有 `CLAUDE.md` 统一重命名为 `AGENTS.md`
- 不在本期把所有 `.claude/skills` 迁移到 `.pi/skills`
- 不在本期重写管理后台的 profile 数据模型
- 不在本期兼容旧的 Claude 远端 session 继续可恢复

## 对现有项目的影响

### 核心行为变化

1. `registered_groups.agent_provider` **本期保留字段名不变**，但语义继续作为“profile key”使用，不再表示底层 SDK 类型。
2. `sessions.session_id` **本期保留字段名不变**，但值将从“Claude 远端 session_id”变成“Pi 本地 session 文件路径”。
3. 数据库中的旧 `session_id` 将被视为无效值；当发现该值不是现存本地文件时，系统会自动丢弃。
4. `clearSession()` 不再调用 Claude `/clear`，而是改为**关闭当前 Pi 会话并创建新的本地 session 文件**。
5. `CLAUDE.md` 与 `.claude/skills` **短期继续复用**：
   - `pi` 会自动读取 `CLAUDE.md`
   - `PiProvider` 会显式把 `.claude/skills` 作为附加 skill 路径加载

### 受影响的文件

#### 需要新增的文件

- `src/providers/pi.ts`
  - `PiProvider` 实现，替代 `ClaudeProvider`
- `src/providers/pi-tool-adapter.ts`
  - 将 `octo` 的 `ToolDefinition` 适配为 `pi` 的 `ToolDefinition`
- `src/providers/pi-mcp-extension.ts`
  - 为外部 MCP server 生成 `pi` extension factory
- `src/providers/pi-session-ref.ts`
  - 负责本地 session 文件目录、session ref 校验与路径解析
- `src/providers/prompt-normalizer.ts`
  - 从 `ClaudeProvider` 中抽出图片预处理、文件链接标注等 provider 无关逻辑

#### 需要修改的文件

- `src/providers/types.ts`
  - 保留接口，但注释与语义更新为“provider-owned session ref”
- `src/providers/index.ts`
  - 导出 `PiProvider`，移除 `ClaudeProvider`
- `src/group-queue.ts`
  - 移除 Claude `listSessions()` 恢复逻辑
  - 改为恢复/清理本地 Pi session ref
  - 保留现有 generation 并发保护
- `src/index.ts`
  - 删除 Claude 代理层初始化
  - 改为初始化 `PiProvider`
- `src/tools.ts`
  - `clear_session` / `clear_context` 返回文案改为通用“AI session”
- `src/runtime/profile-config.ts`
  - 保留 profile 配置解析
  - 删除 `buildClaudeSdkEnv()`
- `tests/providers.test.ts`
  - 删除 Claude `/clear` 相关测试
  - 改为 `PiProvider` 合规测试
- `tests/group-queue.test.ts`
  - 增加本地 session ref 恢复/失效/清理测试
- `tests/runtime.test.ts`
  - 更新 `sessions.session_id` 的语义断言为本地文件路径

#### 需要删除的文件

- `src/providers/claude.ts`
- `src/runtime/openai-proxy.ts`
- `src/runtime/anthropic-logging-proxy.ts`

### 依赖与运行前置

本期推荐直接复用仓库内嵌的 `pi-mono` 源码，而不是先把 `pi-coding-agent` 发布包重新拉进 `octo` 根目录依赖。

建议方案：

1. `octo` 通过相对路径直接导入 `pi-mono/packages/coding-agent/src/index.ts`
2. 在 `pi-mono/` 目录安装 workspace 依赖
3. 运行 `octo` 时由 Bun 直接加载 `pi-mono` 的 TypeScript 源码

实现前置约定：

```bash
cd pi-mono
npm install
```

这样做的原因：

- `octo` 仓库当前已经内嵌 `pi-mono`
- `pi-coding-agent` 的 npm 包导出默认指向 `dist/`，而本仓库当前未预置其构建产物
- 直接复用源码路径更适合当前开发态迁移

## 实现方案

### 一、迁移原则

本次改造采用**单向切换**：

- 不保留 `ClaudeProvider`
- 不保留 dual-run 或 fallback 逻辑
- 不再兼容 Claude 远端 `session_id`
- 只保留 `octo` 上层业务抽象与 profile 配置

这样可以避免出现“表面换了 SDK，底层仍然保留 Claude 语义”的混合状态。

### 二、Profile 到 Pi 模型的映射

`octo` 现有 `config/agent-profiles*.json` 不需要推翻。本期保留它作为 profile 配置源，但在 `PiProvider` 内部把每个 profile 动态注册成 `pi` 的一个**合成 provider**。

核心决策：

- 使用 `profile.profileKey` 作为 `pi` provider 名称
- 每个 profile 只注册一个 model
- 不依赖 `pi` 内置 provider 名称与当前 `octo` profile 名称完全一致

映射函数示意：

```ts
function toPiApi(profile: ResolvedAgentProfile): "anthropic-messages" | "openai-responses" | "openai-chat-completions" {
  if (profile.apiFormat === "anthropic") {
    return "anthropic-messages";
  }

  if (profile.upstreamApi === "chat_completions") {
    return "openai-chat-completions";
  }

  return "openai-responses";
}
```

注册逻辑示意：

```ts
const authStorage = AuthStorage.inMemory();
const modelRegistry = ModelRegistry.inMemory(authStorage);

modelRegistry.registerProvider(profile.profileKey, {
  baseUrl: profile.baseUrl,
  apiKey: profile.apiKey,
  api: toPiApi(profile),
  authHeader: true,
  models: [
    {
      id: profile.model,
      name: profile.model,
      api: toPiApi(profile),
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ],
});
```

本期使用保守默认值（`contextWindow`、`maxTokens`、`cost`）即可，后续若要更精细化，再把这些字段补进 `agent-profiles.json`。

### 三、Pi 会话持久化模型

本次不再使用 Claude 远端 session，而改为使用 Pi 的本地 JSONL session 文件。

#### 设计决策

1. 每个 group 使用独立 session 目录：

```text
groups/<group-folder>/.pi/sessions/
```

2. `sessions.session_id` 字段继续存在，但实际保存的是：

```text
groups/<group-folder>/.pi/sessions/<timestamp>_<session-id>.jsonl
```

3. 恢复逻辑只检查本地文件是否存在：
   - 存在：`SessionManager.open(sessionRef, sessionDir, cwd)`
   - 不存在：删除数据库中的旧值，按新 session 处理

示意代码：

```ts
function resolvePiSessionRef(groupFolder: string, persistedRef: string | null): string | undefined {
  if (!persistedRef) {
    return undefined;
  }

  return existsSync(persistedRef) ? persistedRef : undefined;
}
```

#### 清理语义

`clearContext()` 改为纯本地操作：

1. 关闭当前 active session
2. 丢弃旧 session ref
3. 创建一个新的 `SessionManager`
4. 立刻返回新的 session 文件路径

示意代码：

```ts
const sessionManager = SessionManager.create(workingDirectory, sessionDir);
const sessionRef = sessionManager.getSessionFile();
saveSessionId(db, groupFolder, sessionRef);
```

这样可以保持当前工具接口不变：`clear_session` 仍然能立即返回“新的 session 已就绪”。

### 四、PiProvider 结构

`PiProvider` 继续实现当前 `AgentProvider` 接口，但底层改为 `createAgentSession()`。

关键点：

1. 使用 `SessionManager.open()` 或 `SessionManager.create()` 恢复/新建本地会话
2. 使用 `DefaultResourceLoader` 显式注入：
   - 当前 group 工作目录
   - `.claude/skills`
   - 外部 MCP extension factory
3. 使用 `pi` 自带文件工具 + `octo` 自定义工具
4. 通过 `session.subscribe()` 把 `pi` 事件流转换为 `AgentEvent`

Provider 构造示意：

```ts
const { session } = await createAgentSession({
  cwd: workingDirectory,
  model,
  modelRegistry,
  authStorage,
  sessionManager,
  tools: [
    createReadTool(workingDirectory),
    createBashTool(workingDirectory),
    createEditTool(workingDirectory),
    createWriteTool(workingDirectory),
    createGrepTool(workingDirectory),
    createFindTool(workingDirectory),
    createLsTool(workingDirectory),
  ],
  customTools: octoTools,
  resourceLoader,
});
```

### 五、Prompt 预处理从 Claude 专属逻辑中抽离

当前 `ClaudeProvider` 中有两类能力不应该随着 Claude 删除而消失：

1. 图片消息预处理
2. 本地 Markdown 文件链接标注

因此应把相关逻辑抽到新的 provider-neutral helper，例如：

- `src/providers/prompt-normalizer.ts`

职责：

- 继续调用 `imageMessagePreprocessor.preprocess()`
- 继续把本地 Markdown 文件链接转换为“原链接 + 可读路径”
- 为 `PiProvider.startSession()` 与 `AgentSession.push()` 共用

这样可以保证切换到 Pi 后，现有的图片理解与本地文件链接体验不退化。

### 六、内建工具迁移为 Pi Custom Tools

`octo` 的工具不再通过 Claude MCP server 暴露，而是直接变成 `pi` custom tools。

#### 设计决策

1. 工具名称保留 Claude 时代的 MCP 前缀，避免立即重写 `CLAUDE.md`：

```text
mcp__octo-tools__send_message
mcp__octo-tools__clear_session
...
```

2. 原始 `ToolDefinition.name` 仍保持简洁名，用适配层统一加前缀
3. 参数 schema 沿用现有 JSON Schema，在 `pi` 侧用 `Type.Unsafe()` 包装

适配器示意：

```ts
function toPiTool(tool: OctoToolDefinition): PiToolDefinition {
  return defineTool({
    name: `mcp__octo-tools__${tool.name}`,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.schema),
    async execute(_toolCallId, params) {
      return await tool.handler(params);
    },
  });
}
```

这样做的收益：

- 不需要在本期修改 `groups/MAIN_CLAUDE.md` 中已有的工具名提示
- 不需要让管理者重新学习一套工具名
- 后续如要去掉 `mcp__` 前缀，可以单独做 prompt 与工具名迁移

### 七、外部 MCP 通过 Pi Extension 实现

本期保留“是否注入外部 MCP server”这套业务逻辑，但实现方式改为 `pi` extension。

#### 设计决策

1. `buildGroupExternalMcpServers()` 逻辑保留
2. 新增 `createOctoMcpExtension(servers)`，返回一个 `ExtensionFactory`
3. extension 在 session 启动时：
   - 启动/连接 stdio MCP server
   - 拉取工具列表
   - 为每个外部工具注册一个 `pi` tool

工具命名仍保持：

```text
mcp__<server-name>__<tool-name>
```

示意：

```ts
export function createOctoMcpExtension(servers: Record<string, ExternalMcpServerSpec>): ExtensionFactory {
  return async (pi) => {
    for (const [serverName, serverSpec] of Object.entries(servers)) {
      const tools = await connectAndListMcpTools(serverSpec);

      for (const tool of tools) {
        pi.registerTool({
          name: `mcp__${serverName}__${tool.name}`,
          label: `${serverName}:${tool.name}`,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object" }),
          async execute(_toolCallId, params) {
            return await callMcpTool(serverName, tool.name, params);
          },
        });
      }
    }
  };
}
```

本期重点只保证：

- `markitdown` 这类当前已接入的外部 MCP 能继续工作
- server 生命周期与单次 session 绑定

不在本期追求把所有 MCP 细节抽象成通用框架。

### 八、资源加载与 `CLAUDE.md` / `.claude/skills` 兼容策略

本期不迁移目录命名，只做运行时兼容。

#### 具体方案

1. `CLAUDE.md`
   - 继续保留
   - `pi` 的 `ResourceLoader` 会自动读取

2. `.claude/skills`
   - 通过 `additionalSkillPaths` 接入

示意：

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd: workingDirectory,
  additionalSkillPaths: [
    resolve(workingDirectory, ".claude", "skills"),
  ],
  extensionFactories: [
    createOctoMcpExtension(externalMcpServers),
  ],
});
```

3. `skills/system` 的同步逻辑暂时不动，仍同步到 `groups/<folder>/.claude/skills`

这样做的原因：

- 可以把“去掉 Claude SDK”与“重构所有目录约定”拆成两个阶段
- 当前最重要的是替换运行时，不是清洗所有命名

### 九、GroupQueue 改造

`GroupQueue` 的主并发模型可以保留，只改会话恢复与清理部分。

#### 需要删除的逻辑

- `@anthropic-ai/claude-agent-sdk` 的 `listSessions()`
- `resolveClaudeResumeSessionId()`
- 基于 Claude 远端 session 是否存在的校验

#### 需要保留的逻辑

- `activeSessions`
- `sessionGenerations`
- 清理会话后的 stale result 防回写保护

#### 新逻辑

1. 读取数据库中的 `session_id`（实际是本地文件路径）
2. 若文件不存在，删除数据库旧值
3. 启动 `PiProvider`
4. 收到 `result` 时保存新的 session 文件路径

本期保留 `sessionGenerations` 的原因是：

- `clearSession()` 与活跃流式回调仍然存在并发竞态
- 即使改为 Pi，本地事件流晚到时仍可能污染当前状态

### 十、启动链路清理

`src/index.ts` 里的 Claude 启动链路将整体删除。

删除项：

- `OpenAIProxyManager`
- `AnthropicLoggingProxyManager`
- `ClaudeProvider`
- `buildClaudeSdkEnv()` 相关路径

保留项：

- `MiniMaxTokenPlanMcpClient`
- `DatabaseImageMessagePreprocessor`
- `ChannelManager`
- `GroupQueue`

新的启动逻辑只负责：

1. 初始化数据库与 channel
2. 初始化图片预处理器
3. 初始化 `PiProvider`
4. 创建 `GroupQueue`

### 十一、测试方案

本期至少补齐以下测试：

1. `tests/providers.test.ts`
   - `PiProvider implements AgentProvider`
   - `PiProvider.clearContext()` 返回新的本地 session ref
   - 删除 Claude `/clear` 解析测试

2. `tests/group-queue.test.ts`
   - 本地 session ref 存在时可恢复
   - 旧的 Claude session 字符串会被视为无效并清除
   - `clearSession()` 会生成新的本地 session ref
   - generation 保护仍能阻止 stale result 回写

3. `tests/runtime.test.ts`
   - `saveSessionId()` / `getSessionId()` 仍可工作
   - 断言值从“远端 id”切换为“本地 session 文件路径”

4. `tests/group-memory.test.ts`
   - `clear_session` 返回文案从 “fresh Claude session” 改为通用 “fresh AI session”

本期不新增端到端网络测试；以单元测试和小范围集成测试为主。

## Todo List

### Phase 0: 依赖准备
- [x] 在 `pi-mono/` 安装 workspace 依赖，确认 `octo` 可直接导入 `pi-mono/packages/coding-agent/src/index.ts`
- [x] 确认 `bun test` 运行时能解析 `pi-mono/node_modules`

### Phase 1: Pi runtime 接入
- [x] 新建 `src/providers/pi-session-ref.ts`，统一处理 session 目录、session ref 校验与新建逻辑
- [x] 新建 `src/providers/prompt-normalizer.ts`，抽出图片预处理与本地文件链接标注逻辑
- [x] 新建 `src/providers/pi-tool-adapter.ts`，把 `octo` 工具适配成 `pi` custom tools
- [x] 新建 `src/providers/pi-mcp-extension.ts`，把外部 MCP server 适配成 `pi` extension factory
- [x] 新建 `src/providers/pi.ts`，实现 `PiProvider`

### Phase 2: 替换运行链路
- [x] 修改 `src/providers/index.ts`，移除 `ClaudeProvider` 导出，改为导出 `PiProvider`
- [x] 修改 `src/group-queue.ts`，删除 Claude 远端 session 恢复逻辑，改为本地 session ref 恢复
- [x] 修改 `src/group-queue.ts`，保留并复用现有 generation 防回写机制
- [x] 修改 `src/index.ts`，删除 Claude 代理层初始化，只保留 `PiProvider`
- [x] 修改 `src/runtime/profile-config.ts`，删除 `buildClaudeSdkEnv()`

### Phase 3: 清理 Claude 相关代码
- [x] 删除 `src/providers/claude.ts`
- [x] 删除 `src/runtime/openai-proxy.ts`
- [x] 删除 `src/runtime/anthropic-logging-proxy.ts`
- [x] 从 `package.json` 删除 `@anthropic-ai/claude-agent-sdk`

### Phase 4: 兼容现有资源与文案
- [x] 保持 `CLAUDE.md` 自动加载能力
- [x] 通过 `additionalSkillPaths` 继续加载 `.claude/skills`
- [x] 修改 `src/tools.ts` 中清理会话的返回文案，去掉 “Claude session” 表述

### Phase 5: 测试与验证
- [x] 更新 `tests/providers.test.ts`
- [x] 更新 `tests/group-queue.test.ts`
- [x] 更新 `tests/runtime.test.ts`
- [x] 更新受影响的 `tests/group-memory.test.ts`
- [x] 运行 `bun test tests/*.test.ts`
