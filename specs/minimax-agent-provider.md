# MiniMax agent-provider 接入方案

## 问题描述

当前仓库已经把底层运行时统一收敛为 `ClaudeProvider`，数据库中的 `registered_groups.agent_provider` 实际表示的是 **profile key**，而不再是真正的 SDK provider 类型。

这意味着“增加 minimax agent-provider”在当前架构里的正确落点不是新增一个 `src/providers/minimax.ts`，而是新增一个可选 profile：

- profile key：`minimax`
- 请求格式：`anthropic`
- 直连 endpoint：`https://api.minimaxi.com/anthropic`
- API Key 环境变量：`MINIMAX_API_KEY`

参考 `docs/minimax/text-anthropic-api.md`，MiniMax 已提供 Anthropic API 兼容接口，并明确支持文本、多轮工具调用、`thinking`、流式响应。因此它与当前 `Claude Agent SDK -> Anthropic 兼容上游` 的主链路天然兼容，不需要再引入新的 SDK 或本地 OpenAI 兼容代理链路。

本需求要解决的核心问题是：

1. 让群组可以把 `agent_provider` 切换为 `minimax`
2. 让 `list_profiles`、管理后台、配置文件和文档中都能看到 `minimax`
3. 保证运行时把 `minimax` 当作 Anthropic 兼容直连 profile，而不是 OpenAI proxy profile
4. 为新增 profile 补齐测试，避免以后改配置时把它破坏掉

本次需求的非目标：

- 不新增 `src/providers/minimax.ts`
- 不改造 `GroupQueue` / `ClaudeProvider` 的主流程
- 不接入 MiniMax 标准 OpenAI 接口
- 不扩展图像或文档输入能力；官方文档当前明确标注 Anthropic 兼容接口暂不支持这两类输入

## 对现有项目的影响

### 需要修改的文件

- `config/agent-profiles.json`
- `config/agent-profiles.example.json`
- `env.example`
- `README.md`
- `docs/multi-agent-provider.md`
- `docs/octo.md`
- `tests/runtime.test.ts`
- `tests/admin-api.test.ts`

### 预计不需要修改的运行时代码

以下文件已经具备接入 `minimax` 所需的抽象能力，本次不计划改动：

- `src/runtime/profile-config.ts`
- `src/providers/claude.ts`
- `src/group-queue.ts`
- `src/tools.ts`
- `src/admin/api.ts`

原因如下：

1. profile 是动态从配置文件读取的，不是写死在代码里的
2. `ClaudeProvider` 对 `apiFormat = "anthropic"` 的 profile 会直接注入 `ANTHROPIC_*` 环境变量
3. `list_profiles` 和管理后台可选 profile 都来自 `listAgentProfiles()`，不需要额外注册

### 兼容性与风险

- `minimax` 将走 Anthropic 兼容直连，不经过 `src/runtime/openai-proxy.ts`
- 当前 `src/runtime/openai-proxy.ts` 中已有少量 `provider === "minimax"` 的兼容逻辑，但在本方案下不会进入该链路；本次先不清理，避免扩大改动面
- MiniMax 文档说明 Anthropic 兼容接口支持工具调用，但不支持图像和文档输入；当前 Octo 主链路以文本 + 工具为主，和现状兼容
- 默认模型按需求固定为 `MiniMax-M2.7`，避免实现阶段反复改动；后续如果要切成其他 MiniMax Anthropic 兼容模型，再通过 profile 配置调整

## 实施方案

### 一、架构决策

新增的不是新的 runtime provider，而是新的 profile：

```text
群消息
  → GroupQueue
    → resolveAgentProfile(group.agent_provider)
    → ClaudeProvider.startSession()
      → Claude Agent SDK
        → MiniMax Anthropic 兼容接口
```

也就是说，群组里存的仍然是：

```ts
group.agent_provider = "minimax";
```

但运行时并不会走新的 provider 类，而是复用现有 `ClaudeProvider`。

### 二、配置文件改动

在 `config/agent-profiles.json` 与 `config/agent-profiles.example.json` 中新增 `minimax` profile，建议定义如下：

```json
{
  "minimax": {
    "apiFormat": "anthropic",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "apiKeyEnv": "MINIMAX_API_KEY",
    "model": "MiniMax-M2.7",
    "provider": "minimax"
  }
}
```

这里的关键点：

1. `apiFormat` 必须是 `anthropic`
2. 不设置 `upstreamApi`
3. `baseUrl` 使用 `docs/minimax/text-anthropic-api.md` 中给出的 `https://api.minimaxi.com/anthropic`
4. `provider` 写成 `minimax`，便于 `list_profiles` / 管理后台展示和后续 provider 特殊兼容扩展

### 三、环境变量与文档同步

在 `env.example` 中新增：

```bash
MINIMAX_API_KEY=sk-xxx
```

同时更新以下文档，使仓库内所有“可用 profile 列表”和示例配置保持一致：

- `README.md`
- `docs/multi-agent-provider.md`
- `docs/octo.md`

文档需要明确：

1. `minimax` 是 Anthropic 兼容直连 profile
2. `minimax` 不经过本地 OpenAI proxy
3. 示例 profile 中新增 `MINIMAX_API_KEY` 和 `MiniMax-M2.7`
4. `switch_provider` / `list_profiles` 的示例里可以切到 `minimax`

### 四、测试改动

#### 1. `tests/runtime.test.ts`

扩展临时 profile 配置，加入 `minimax`：

```ts
minimax: {
  apiFormat: "anthropic",
  baseUrl: "https://api.minimaxi.com/anthropic",
  apiKeyEnv: "MINIMAX_API_KEY",
  model: "MiniMax-M2.7",
  provider: "minimax",
}
```

新增断言至少覆盖：

1. `resolveAgentProfile("minimax")` 返回 `apiFormat = "anthropic"`
2. `resolveAgentProfile("minimax")` 返回正确的 `baseUrl`
3. `buildClaudeSdkEnv(resolveAgentProfile("minimax"))` 会生成正确的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`
4. `listAgentProfiles()` 结果中包含 `minimax`

#### 2. `tests/admin-api.test.ts`

在测试用配置中加入 `minimax`，并验证：

1. `availableProfiles` 列表中出现 `minimax`
2. `PATCH /api/admin/groups/:folder` 时可以把 `agentProvider` 改成 `minimax`

### 五、实现边界

本次实现不应修改以下主逻辑：

```ts
// src/providers/claude.ts
const proxyRoute =
  config.profile.apiFormat === "openai"
    ? this.proxyManager.acquire(config.profile)
    : undefined;
```

原因是 `minimax` 在本方案里本来就应该满足：

```ts
config.profile.apiFormat === "anthropic";
```

因此只要 profile 配置正确，运行时自然会走直连 Anthropic 兼容链路。

### 六、验收标准

完成后应满足以下结果：

1. `config/agent-profiles*.json` 中存在 `minimax` profile
2. `list_profiles` 输出里能看到 `minimax`
3. 管理后台可选 profile 列表中能看到 `minimax`
4. 群组的 `agent_provider` 可成功切换为 `minimax`
5. `resolveAgentProfile("minimax")` 的测试通过
6. 文档里出现一致的 `MINIMAX_API_KEY` / `https://api.minimaxi.com/anthropic` / `MiniMax-M2.7`

## Todo List

- [x] 新增 `specs/minimax-agent-provider.md` 并完成评审
- [x] 修改 `config/agent-profiles.json`，加入 `minimax` profile
- [x] 修改 `config/agent-profiles.example.json`，加入 `minimax` profile
- [x] 修改 `env.example`，加入 `MINIMAX_API_KEY`
- [x] 更新 `README.md` 中的 profile 列表、配置示例和说明
- [x] 更新 `docs/multi-agent-provider.md` 中的 profile 架构说明
- [x] 更新 `docs/octo.md` 中的 profile 语义说明
- [x] 更新 `tests/runtime.test.ts`，补充 `minimax` 的 profile 解析与 env 断言
- [x] 更新 `tests/admin-api.test.ts`，补充管理后台对 `minimax` 的可见性和切换断言
- [x] 运行相关测试并确认全部通过
