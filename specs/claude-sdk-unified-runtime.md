# 统一 Claude Agent SDK 运行时与 Proxy 路由收敛

## 问题描述

当前 Octo 同时维护了三套底层 agent 运行链路：

- `src/providers/claude.ts`：直接使用 Claude Agent SDK
- `src/providers/codex.ts`：通过 Codex SDK + wrapper + 独立 MCP stdio server
- `src/providers/kimi.ts`：通过 Kimi SDK + Node 子进程包装

这套设计已经出现了结构性问题：

1. 不同 agent 对工作目录和指令文件的识别规则不同。Claude 读 `CLAUDE.md` / `.claude/skills`，Codex 读 `AGENTS.md` / `.agents/skills`，当前只能靠 symlink 和 wrapper 补救。
2. session 不能共享。`src/db.ts` 中 `updateGroupProvider()` 在切换 provider 时会直接删除 `sessions` 表记录，因为 Codex/Kimi/Claude 的 session ID 互不兼容。
3. 工具链分叉严重。Claude 用进程内 MCP，Codex 需要 `src/mcp-stdio-server.ts` + 内部 HTTP API，Kimi 需要 `/internal/tool-call` 反向转发。
4. 运维复杂度高。当前依赖 `@anthropic-ai/claude-agent-sdk`、`@openai/codex-sdk`、`@moonshot-ai/kimi-agent-sdk` 三套 SDK，行为边界、报错模型、权限模型都不一致。

本需求的目标是参考 `mini_cowork`，把 **底层运行时统一收敛到 Claude Agent SDK**，再通过本地 proxy 将 Claude Agent SDK 发出的 Anthropic 风格请求转换到 OpenAI 兼容上游，从而让不同模型线路共享：

- 同一套工作目录识别
- 同一套 `CLAUDE.md` / `.claude/skills`
- 同一套工具接入方式
- 同一套 Claude session 持久化与恢复机制

本次改造的非目标：

- 不保留 Codex SDK / Kimi SDK 的独有行为
- 不继续维护 `AGENTS.md` / `.agents/skills` 的兼容链路
- 不直接复用 `mini_cowork` 当前“单一全局 upstreamConfig”实现；Octo 有多群并发，这种实现会串线

## 对现有项目的影响

### 需要修改的核心文件

- `src/providers/claude.ts`
- `src/group-queue.ts`
- `src/db.ts`
- `src/index.ts`
- `src/tools.ts`
- `src/providers/index.ts`
- `tests/providers.test.ts`
- `README.md`
- `docs/octo.md`
- `docs/multi-agent-provider.md`
- `env.example`

### 需要新增的文件

- `src/runtime/profile-config.ts`：解析群组线路配置，输出 Claude SDK 所需的 `env`
- `src/runtime/openai-proxy.ts`：Anthropic → OpenAI 兼容代理，支持流式响应
- `src/runtime/openai-transform.ts`：请求/响应格式转换，参考 `mini_cowork/src/transform.ts`
- `src/runtime/types.ts`：线路配置、上游配置、proxy route 等类型
- `config/agent-profiles.example.json`：线路配置示例文件

### 计划删除的文件

- `src/providers/codex.ts`
- `src/providers/kimi.ts`
- `src/providers/registry.ts`
- `src/mcp-stdio-server.ts`
- `store/codex-wrapper.sh`（运行时不再依赖；已有文件无需手动清理）

### 依赖层面的变化

计划移除以下依赖：

- `@openai/codex-sdk`
- `@moonshot-ai/kimi-agent-sdk`
- `@modelcontextprotocol/sdk`

保留并继续作为唯一底层 runtime 的依赖：

- `@anthropic-ai/claude-agent-sdk`
- `zod`

### 数据与兼容性影响

为降低迁移成本，本阶段 **保留** `registered_groups.agent_provider` 字段，但重新定义其语义：

- 改造前：底层 SDK 类型（`claude` / `codex` / `kimi`）
- 改造后：群组使用的“模型线路 profile key”

也就是说，`claude` / `codex` / `kimi` 以后不再表示不同 SDK，而是表示不同上游模型线路别名。例如：

- `claude` → Anthropic 直连线路
- `codex` → OpenAI 兼容线路（默认别名，底层仍是 Claude Agent SDK）
- `kimi` → Moonshot/Kimi 线路（默认别名，底层仍是 Claude Agent SDK）
- `kimi-cli` → Moonshot/Kimi Coding Plan 线路（等价于 `codingPlanEnabled=true`，底层仍是 Claude Agent SDK）

这样可以做到：

- 数据库不必做破坏性 rename
- 现有 `switch_provider` 工具和已有群组数据可以继续工作
- session 不再因为切线路而被强制删除

## 实施方案

### 一、目标架构

改造后的主链路：

```text
飞书群消息
  → Router
    → GroupQueue
      → 读取 group.agent_provider（此时含义是 profile key）
      → resolveAgentProfile()
      → ClaudeProvider.startSession()
        → Claude Agent SDK query()
          → 直连 Anthropic 兼容上游
          或
          → 本地 OpenAI 兼容 proxy
            → OpenAI / Moonshot / Gemini / 其他 OpenAI 兼容接口
```

关键约束：

1. 所有群组无论选择什么 profile，实际都只走 `ClaudeProvider`
2. 所有工具都只通过 Claude SDK 的进程内 MCP 接入
3. 所有群组都只识别 `CLAUDE.md` / `.claude/skills`
4. 所有 session 都只保存 Claude session ID

### 二、profile 配置模型

新增一份项目级配置文件，例如 `config/agent-profiles.json`。配置由“逻辑线路名”映射到“真实上游配置”。

建议示例：

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
      "apiFormat": "openai",
      "upstreamApi": "chat_completions",
      "baseUrl": "https://api.moonshot.cn/v1",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5"
    },
    "kimi-cli": {
      "apiFormat": "openai",
      "upstreamApi": "chat_completions",
      "baseUrl": "https://api.kimi.com/coding/v1",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5",
      "codingPlanEnabled": true
    }
  }
}
```

这里刻意保留了 `claude` / `codex` / `kimi` 这三个逻辑入口，原因是：

- 当前数据库和管理工具已经在使用这些名字
- 用户侧切换命令不需要立即改变
- 但这些名字只作为 profile alias，不再代表不同 agent SDK

配置解析模块负责把 profile 转换成 Claude SDK 需要的运行参数：

```ts
type ResolvedAgentProfile = {
  profileKey: string;
  apiFormat: "anthropic" | "openai";
  upstreamApi?: "chat_completions" | "responses";
  baseUrl: string;
  apiKey: string;
  model: string;
  codingPlanEnabled?: boolean;
};

function resolveAgentProfile(profileKey: string): ResolvedAgentProfile;
function buildClaudeSdkEnv(profile: ResolvedAgentProfile): Record<string, string>;
```

这里对 Kimi 需要明确拆成两个 profile：

- `kimi`：普通 Kimi 线路，不开启 coding plan
- `kimi-cli`：Kimi Coding Plan 线路，语义上等价于 `mini_cowork` 里的 `codingPlanEnabled=true`

这样做的原因是：

- 这两条线路虽然底层都通过 Claude SDK + proxy 运行，但上游 base URL 和能力边界不同
- 群组切换时应该明确选择线路，而不是在一个 provider 名下再叠加额外布尔开关
- 数据库里保留清晰的 profile key，后续排查和运营更直观

### 三、ClaudeProvider 改造

`src/providers/claude.ts` 继续保留，但职责升级为“唯一运行时 provider”。

新的 `SessionConfig` 增加一段 profile 信息：

```ts
interface SessionConfig {
  groupFolder: string;
  workingDirectory: string;
  initialPrompt: string;
  isMain: boolean;
  resumeSessionId?: string;
  tools: ToolDefinition[];
  profile: ResolvedAgentProfile;
}
```

在 `ClaudeProvider.startSession()` 内部：

1. 根据 `config.profile` 构造运行时 `env`
2. 若 `apiFormat === "anthropic"`，直接把 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 注入 Claude SDK
3. 若 `apiFormat === "openai"`，则向本地 proxy manager 申请一条专属 route，并把 route base URL 注入 `ANTHROPIC_BASE_URL`

调用形态类似：

```ts
const queryIter = query({
  prompt: messageGenerator(config.initialPrompt),
  options: {
    cwd: config.workingDirectory,
    env: buildClaudeSdkEnv(config.profile),
    settingSources: ["project"],
    mcpServers: { "octo-tools": mcpServer },
    allowedTools,
    permissionMode: "bypassPermissions",
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {})
  }
});
```

这样之后，不论群组选择的是 `claude` / `codex` / `kimi`，Claude SDK 都会在同一个工作目录里运行，目录识别和技能发现行为天然一致。

### 四、OpenAI 兼容 proxy 设计

这里不能直接照抄 `mini_cowork/src/proxy.ts` 的全局单例实现，因为 Octo 当前 `GroupQueue` 允许多个群组并发运行，不同群组可能同时指向不同上游。

如果继续使用单一全局 `upstreamConfig`，会出现：

- A 群正在跑 `codex` profile
- B 群切到 `kimi` profile 并重写 proxy 的 upstream
- A 群后续请求被错误转发到 Kimi

因此 Octo 里必须实现 **多租户 proxy manager**。建议结构：

```ts
type ProxyRouteHandle = {
  routeId: string;
  baseUrl: string;
  apiKey: string;
  release(): void;
};

class OpenAIProxyManager {
  async start(): Promise<void>;
  acquire(upstream: ResolvedAgentProfile): ProxyRouteHandle;
}
```

实现要点：

1. 只启动一个本地 HTTP server，但每个 session/profile 拿到不同的 route
2. route 可以通过 URL 前缀区分，例如：
   - `http://127.0.0.1:9901/proxy/<routeId>`
3. proxy 收到 Claude SDK 发来的 Anthropic `/v1/messages` 请求后：
   - 根据 `<routeId>` 找到对应 upstream config
   - 把 Anthropic 请求体转换成 OpenAI `chat.completions` 或 `responses`
   - 把上游 SSE / JSON 响应重新转换回 Anthropic 事件流
4. route 生命周期与一次 `startSession()` 绑定；session 结束后释放 route

### 五、格式转换逻辑

`src/runtime/openai-transform.ts` 基本参考 `mini_cowork/src/transform.ts`，但只保留 Octo 当前需要的子集：

- `anthropicToOpenAI()`
- `openAIToAnthropic()`
- `buildOpenAIChatCompletionsURL()`
- `mapStopReason()`
- `formatSSEEvent()`

同时从 `mini_cowork/src/proxy.ts` 提取并适配：

- OpenAI `responses` 流式 function call 转 Anthropic `tool_use`
- OpenAI `chat.completions` 流式 `tool_calls` 转 Anthropic `tool_use`
- 工具调用参数累积与收尾
- 失败请求的错误体标准化

这里的原则不是完整复制 `mini_cowork` 的所有 provider 特判，而是先保证 Octo 现在需要的三条逻辑线路：

- `claude`
- `codex`
- `kimi`

并额外支持一条 Kimi Coding Plan 线路：

- `kimi-cli`

后续如果要增加 DeepSeek/Qwen/Gemini，再在该模块增量扩展。

### 六、GroupQueue 与 session 语义调整

`src/group-queue.ts` 的职责从“按 SDK provider 分发”改成“读取群组 profile，统一交给 ClaudeProvider”。

改造后的行为：

1. 读取 `group.agent_provider`
2. 调用 `resolveAgentProfile(group.agent_provider)`
3. 使用同一个 `ClaudeProvider.startSession()`
4. 保存返回的 Claude session ID

关键变化是：`updateGroupProvider()` 不再清空 session。

旧逻辑：

```ts
UPDATE registered_groups SET agent_provider = $provider WHERE folder = $folder
DELETE FROM sessions WHERE group_folder = $folder
```

新逻辑：

```ts
UPDATE registered_groups SET agent_provider = $provider WHERE folder = $folder
```

原因：

- 现在所有群组都只有 Claude session
- session transcript 与具体上游 provider 解耦
- 同一群组切换 `claude` / `codex` / `kimi` / `kimi-cli` 后仍可继续之前上下文

如果后续需要“切线路时重置上下文”，应该新增显式的 `reset_session` 工具，而不是隐式删除。

### 七、启动流程与目录初始化调整

`src/index.ts` 中要做几件事：

1. 删除 `ProviderRegistry` 注册 `CodexProvider` / `KimiProvider` 的逻辑
2. 改为只实例化 `ClaudeProvider`
3. 启动 `OpenAIProxyManager`
4. 初始化群组目录时只保留：
   - `CLAUDE.md`
   - `.claude/skills`

以下兼容逻辑可以删除：

- `AGENTS.md → CLAUDE.md` symlink
- `.agents/skills → .claude/skills` symlink
- `Bun.serve()` 的 `/internal/send`、`/internal/send-image`、`/internal/tool-call` 等内部 API

原因是这些分支全部只为 Codex/Kimi 的进程外工具调用服务；统一到 Claude 进程内 MCP 后不再需要。

### 八、工具层与管理命令调整

`src/tools.ts` 中的 `switch_provider` 工具保留名字，但语义更新为“切换群组 profile”。

需要同步修改：

- description：不再写死为“Available providers: claude, codex”
- handler：写入的是 profile key
- 增加 profile 是否存在的校验

如果 profile 不存在，应返回可配置 profile 列表，而不是静默写入数据库。

可选但推荐新增一个只读工具：

- `list_profiles`：列出当前配置文件中的所有 profile、模型、apiFormat

这样主群可以先查有哪些线路，再切换。

### 九、测试策略

测试需要从“多 SDK 合规”改成“单运行时 + 多 profile 路由”：

1. `tests/providers.test.ts`
   - 删除 `CodexProvider` / `KimiProvider` 合规测试
   - 保留 `ClaudeProvider` 合规测试
2. 新增 profile 配置解析测试
   - 正常 profile 解析
   - profile 缺失时 fallback 到 default
   - env 缺失时报错
3. 新增 proxy 转换测试
   - Anthropic request → OpenAI request
   - OpenAI streaming tool call → Anthropic tool_use
   - responses API / chat.completions API 两条路径
4. 新增数据库行为测试
   - `switch_provider` / `updateGroupProvider()` 不再删除 session

### 十、文档与运维调整

需要同步更新：

- README 中的架构图和 provider 说明
- `docs/octo.md`
- `docs/multi-agent-provider.md`
- `env.example`

`env.example` 至少应补充：

```bash
OPENAI_API_KEY=sk-xxx
MOONSHOT_API_KEY=sk-xxx
AGENT_PROFILES_PATH=config/agent-profiles.json
OPENAI_PROXY_PORT=9901
```

文档和示例配置里要明确展示：

- `kimi`
- `kimi-cli`

两条线路都使用 `MOONSHOT_API_KEY`，但 `kimi-cli` 指向 coding plan endpoint。

## Todo List

### Phase 1: 统一配置与路由抽象
- [x] 新增 `src/runtime/types.ts`
- [x] 新增 `src/runtime/profile-config.ts`
- [x] 新增 `config/agent-profiles.example.json`
- [x] 约定 `agent_provider` 字段的新语义为 profile key，并补充兼容说明

### Phase 2: 实现多租户 OpenAI 兼容 proxy
- [x] 新增 `src/runtime/openai-transform.ts`
- [x] 新增 `src/runtime/openai-proxy.ts`
- [x] 参考 `mini_cowork` 提取 Anthropic ↔ OpenAI 的请求/响应转换逻辑
- [x] 实现按 routeId 隔离的多租户 upstream 配置，避免多群并发串线

### Phase 3: 收敛到底层单一 Claude 运行时
- [x] 修改 `src/providers/claude.ts`，让其接收 resolved profile 并按 profile 构造运行时 env
- [x] 修改 `src/group-queue.ts`，去掉按 SDK provider 分发，统一走 ClaudeProvider
- [x] 修改 `src/index.ts`，只保留 ClaudeProvider 和 proxy manager 启动逻辑
- [x] 修改 `src/providers/index.ts`，删除 Codex/Kimi/Registry 的导出

### Phase 4: 删除旧链路与兼容补丁
- [x] 删除 `src/providers/codex.ts`
- [x] 删除 `src/providers/kimi.ts`
- [x] 删除 `src/providers/registry.ts`
- [x] 删除 `src/mcp-stdio-server.ts`
- [x] 删除 `src/index.ts` 中 `AGENTS.md` / `.agents/skills` symlink 初始化逻辑
- [x] 删除内部 `/internal/*` API
- [x] 停止生成和依赖 `store/codex-wrapper.sh`

### Phase 5: 调整数据库与管理工具语义
- [x] 修改 `src/db.ts` 中 `updateGroupProvider()`，切 profile 时不再删除 session
- [x] 修改 `src/tools.ts` 中 `switch_provider` 的说明、校验和返回信息
- [x] 视情况新增 `list_profiles` 工具

### Phase 6: 测试与文档
- [x] 更新 `tests/providers.test.ts`
- [x] 新增 profile 配置解析测试
- [x] 新增 proxy 转换测试
- [x] 新增 `updateGroupProvider()` session 保留测试
- [x] 更新 `README.md`
- [x] 更新 `docs/octo.md`
- [x] 更新 `docs/multi-agent-provider.md`
- [x] 更新 `env.example`
