# Kimi Coding Plan 兼容修复

## 问题说明

当前项目里群组切换到 `agent_provider = "kimi-cli"` 后，请求会按 OpenAI 兼容链路发送：

- profile 配置为 `apiFormat = "openai"`
- `baseUrl = "https://api.kimi.com/coding/v1"`
- Claude Agent SDK 通过本地 `openai-proxy` 做 Anthropic -> OpenAI 转换后再转发

但从 `mini_cowork` 的已验证实现可以确认，Moonshot/Kimi 的 `codingPlanEnabled` 在 Claude Agent SDK 场景下并不是走这条链路，而是：

- 默认 Moonshot provider 使用 `apiFormat = "anthropic"`
- 普通模式走 `https://api.moonshot.cn/anthropic`
- 开启 `codingPlanEnabled` 后切到 `https://api.kimi.com/coding`
- 仍然保持 Anthropic 兼容请求格式，直接由 Claude Agent SDK 发起请求

这也是当前 `kimi-cli` 报错的直接原因。日志里已经出现了明确上游反馈：

```text
403 ... "Kimi For Coding is currently only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo Code, etc."
```

也就是说，上游没有把我们当前这条 OpenAI 兼容代理链路识别成受支持的 Coding Agent。

## 对现有项目的影响

受影响的模块和文件：

- `config/agent-profiles.json`
- `config/agent-profiles.example.json`
- `src/runtime/profile-config.ts`
- `README.md`
- `docs/multi-agent-provider.md`
- `tests/providers.test.ts`
- `tests/runtime.test.ts`

行为影响：

- `kimi-cli` 的实际请求路径会从当前的 OpenAI 兼容代理链路切换为 Anthropic 兼容直连链路。
- `kimi` 普通线路也应与 `mini_cowork` 保持一致，优先改为 `https://api.moonshot.cn/anthropic`。
- `codingPlanEnabled` 将从“仅存储在配置对象里但运行时未生效”变成“参与 endpoint 决策”的有效配置。
- OpenAI 兼容代理只保留给真正需要 OpenAI 格式转发的 profile，例如 `codex`。
- README 和示例配置中的 Moonshot/Kimi endpoint 说明也需要同步，否则运行时修好了，文档仍会继续误导后续配置。

风险点：

- 现有 `kimi` / `kimi-cli` 配置语义会发生调整，需要确保不影响 `codex` 和 `claude`。
- 如果已有用户手工配置了 Moonshot 的自定义 endpoint，需要明确运行时是否覆盖，避免破坏显式自定义。
- 仓库当前工作区已有未提交变更，实施时只能在目标文件上增量修改，不能回滚无关变更。

## 实现方案

目标是让 `octo` 的 Moonshot/Kimi 线路与 `mini_cowork` 的已验证行为对齐，而不是继续依赖当前这套错误的 `openai` 配置。

### 方案原则

1. `codingPlanEnabled` 不能只是透传字段，必须真正参与 endpoint 解析。
2. Moonshot provider 在 Claude Agent SDK 场景下，应优先视为 Anthropic 兼容 provider。
3. `kimi-cli` 的“CLI”语义应体现在使用 Coding Plan Anthropic endpoint，而不是强制走 OpenAI 代理。

### 具体改动

#### 1. 在运行时补全 Moonshot Coding Plan endpoint 解析

在 `src/runtime/profile-config.ts` 中新增类似 `mini_cowork` 的 provider endpoint 解析逻辑。对于：

- `provider === "moonshot"`
- `codingPlanEnabled === true`

若 profile 当前用于 Claude Agent SDK，则解析为：

- `apiFormat = "anthropic"`
- `baseUrl = "https://api.kimi.com/coding"`

普通 Moonshot 线路解析为：

- `apiFormat = "anthropic"`
- `baseUrl = "https://api.moonshot.cn/anthropic"`

这样即使配置文件里仍保留逻辑别名 `kimi` / `kimi-cli`，运行时拿到的 `ResolvedAgentProfile` 也会是真正可用的链路。

兼容策略补充：

- 对 `provider !== "moonshot"` 的 profile 不做任何兼容改写。
- 对 `provider === "moonshot"` 的 profile，统一按 `mini_cowork` 语义解析为 Anthropic 兼容直连。
- 解析后显式清空 `upstreamApi`，避免后续逻辑误判为 OpenAI 兼容 profile。

伪代码示意：

```ts
function applyProviderCompatibility(config: AgentProfileConfig): AgentProfileConfig {
  if (config.provider === "moonshot") {
    return {
      ...config,
      apiFormat: "anthropic",
      baseUrl: config.codingPlanEnabled
        ? "https://api.kimi.com/coding"
        : "https://api.moonshot.cn/anthropic",
      upstreamApi: undefined,
    };
  }

  return config;
}
```

#### 2. 调整 profile 配置文件，消除误导

同步修正：

- `config/agent-profiles.json`
- `config/agent-profiles.example.json`

使 `kimi` / `kimi-cli` 的静态定义也与运行时语义一致，避免再次把 `kimi-cli` 写成：

```json
{
  "apiFormat": "openai",
  "baseUrl": "https://api.kimi.com/coding/v1"
}
```

建议改为：

```json
{
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
```

同时补充约束：

- `kimi` 使用 `https://api.moonshot.cn/anthropic`
- `kimi-cli` 使用 `https://api.kimi.com/coding`
- 两者都不再声明 `upstreamApi`
- 两者都保持 `provider = "moonshot"`，使运行时兼容规则和静态配置语义一致

#### 3. 保持 `ClaudeProvider` 当前逻辑，避免无谓扩大改动面

`src/providers/claude.ts` 当前的关键分流是：

- `apiFormat === "openai"` 时才获取 `openai-proxy`
- `apiFormat === "anthropic"` 时直接把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 注入 Claude SDK

如果上一步解析正确，这里不需要做结构性修改，只需要确认日志能体现真实 endpoint。

#### 4. 增加测试覆盖

新增或更新测试，至少覆盖：

- Moonshot 普通线路解析为 `anthropic + https://api.moonshot.cn/anthropic`
- Moonshot `codingPlanEnabled=true` 解析为 `anthropic + https://api.kimi.com/coding`
- `kimi-cli` 不再要求 OpenAI proxy

建议新增针对 `resolveAgentProfile` / endpoint 解析函数的单元测试。

测试拆分建议：

- `tests/runtime.test.ts`
  - 增加 Moonshot 普通模式和 Coding Plan 模式的 profile 解析断言
  - 断言 `buildClaudeSdkEnv()` 对 `kimi-cli` 使用的是直连 endpoint
- `tests/providers.test.ts`
  - 保持 provider 接口测试
  - 增加最小化断言，确保 Anthropic profile 不依赖 `OpenAIProxyManager`

#### 5. 同步文档和示例说明

需要更新：

- `README.md`
- `docs/multi-agent-provider.md`

更新内容：

- 明确 `kimi` / `kimi-cli` 现在都属于 Moonshot 的 Anthropic 兼容线路
- 明确 `kimi-cli` 的 Coding Plan 走 `https://api.kimi.com/coding`
- 明确 OpenAI compatibility proxy 只用于真正的 OpenAI 格式 profile，例如 `codex`

### 为什么不继续沿用 OpenAI 兼容代理

因为实际运行日志已经表明，`https://api.kimi.com/coding/v1` 这条代理后链路虽然能返回错误响应，但上游判定我们并不是受支持的 Coding Agent。`mini_cowork` 的可用实现也证明，在 Claude Agent SDK 场景下，Moonshot Coding Plan 的正确用法是 Anthropic 兼容直连，而不是 OpenAI 兼容中转。

## Todo List

- [x] 为 Moonshot provider 梳理普通模式与 Coding Plan 模式的运行时 endpoint 规则
- [x] 在 `src/runtime/profile-config.ts` 中实现 Moonshot 兼容解析逻辑
- [x] 调整 `config/agent-profiles.json`
- [x] 调整 `config/agent-profiles.example.json`
- [x] 更新 `README.md` 和 `docs/multi-agent-provider.md`，修正文档中的 Kimi 链路说明
- [x] 为 profile 解析补充单元测试
- [x] 运行测试并验证 `kimi-cli` 不再走 OpenAI proxy
