# Pi 接入后的工程化加固

## 问题描述

当前 `octo` 已经完成从 Claude Agent SDK 到 Pi runtime 的主链路迁移，但“工程化护栏”仍然偏薄，主要体现在：

1. 现有测试以单元测试和接口契约测试为主。
2. `tests/providers.test.ts` 已覆盖 `PiProvider` 的接口形状、prompt 归一化、tool 适配和 session ref 解析，但**还没有一层真正驱动 `PiProvider.startSession()` 的本地 smoke test**。
3. 外部 MCP extension 已经接入 `createPiMcpExtensionBundle()`，但目前只靠静态逻辑验证，没有真实 stdio MCP server 交互测试。
4. `pi-mono` 是通过相对路径直接加载源码，一旦后续升级 `pi-mono`、`@modelcontextprotocol/sdk`、或者调整 `PiProvider` 事件桥接逻辑，现有测试未必能第一时间暴露真实集成回归。

本轮“先做工程化”的目标，不是继续扩大功能范围，而是为当前迁移结果补上更可靠的测试护栏：

1. 为 `PiProvider` 增加一层本地 smoke test
2. 为 `pi-mcp-extension` 增加真实 stdio MCP 集成测试
3. 把这层测试纳入仓库脚本，便于后续快速回归验证

本轮非目标：

- 不修改默认 profile/fallback 行为
- 不修改 session 文件清理策略
- 不做运行时缓存优化
- 不重命名数据库字段

## 对现有项目的影响

### 影响范围

本次改动预计以测试与测试辅助文件为主，生产运行时原则上不改行为。

#### 预计新增文件

- `tests/fixtures/fake-mcp-server.ts`
  - 一个最小可执行的 stdio MCP server
  - 用于验证 `createPiMcpExtensionBundle()` 的真实连接、`listTools()`、`callTool()` 路径

#### 预计修改文件

- `tests/providers.test.ts`
  - 新增 `PiProvider.startSession()` 的 smoke test
  - 新增外部 MCP bridge 的真实交互测试
- `package.json`
  - 新增更聚焦的测试脚本，例如 `test:providers` 或 `test:pi`

#### 可能需要小幅调整的文件

- `src/providers/pi-mcp-extension.ts`
  - 仅在测试落地时，如果发现当前结构不便于稳定测试，允许增加极小的测试友好改造
  - 例如更明确的错误包装、连接失败日志、或一个不影响生产行为的内部导出

### 风险与收益

收益：

1. 升级 `pi-mono` 时更容易发现真实集成回归
2. 外部 MCP server 不再只靠静态推断，能够覆盖真实 stdio 生命周期
3. 后续再做 profile fallback、session cleanup、provider queue 等行为优化时，回归成本更低

风险：

1. 如果 smoke test 直接依赖真实远端模型 API，会导致测试不稳定且需要网络
2. `pi` 内部如果默认采用 streaming 协议，测试假服务需要模拟到足够接近的协议形态
3. stdio MCP fixture 若写得太“假”，仍可能遗漏真实兼容性问题

因此本轮策略是：**所有 smoke test 都使用本地假服务，不依赖公网，不依赖真实模型账号。**

## 实现方案

### 一、总体策略

本轮采用“两层护栏”：

1. **MCP 真实交互层**
   - 直接验证 `createPiMcpExtensionBundle()` 能否连接一个本地 stdio MCP server
   - 验证它是否能正确拿到 tool 列表并注册为 `mcp__<server>__<tool>`
   - 验证 callTool 结果能否被正确规范化为 Pi tool content

2. **Provider 本地 smoke 层**
   - 驱动 `PiProvider.startSession()` 的真实执行路径
   - 验证：
     - session 能启动
     - 初始 prompt 能执行
     - assistant text 能桥接成 `AgentEvent.text`
     - turn 完成后能产出 `AgentEvent.result`
     - 本地 session 文件能落盘

### 二、MCP fixture 设计

新增一个最小 fake MCP server：

文件：

- `tests/fixtures/fake-mcp-server.ts`

行为：

1. 通过 stdio 暴露 MCP server
2. 提供至少一个 tool，例如 `echo_text`
3. `echo_text` 接收：

```ts
{
  text: string
}
```

4. 返回：

```ts
{
  content: [
    { type: "text", text: `echo:${text}` }
  ]
}
```

可选再加一个资源型返回，验证 `resource` / `resource_link` 的归一化逻辑是否稳定。

这样 `tests/providers.test.ts` 可以直接通过：

```ts
createPiMcpExtensionBundle({
  fake: {
    command: process.execPath,
    args: [fixturePath],
  },
}, cwd)
```

驱动真实 stdio 连接，而不是 mock `Client.listTools()`。

### 三、PiProvider smoke test 设计

`PiProvider.startSession()` 的真正难点在于它会调用 `createAgentSession()`，而后者最终会尝试请求模型 API。

为了避免联网，本轮增加一个**本地假模型服务**，由测试进程内启动 HTTP server，向 Pi 暴露一个最小兼容接口。

实现形态：

- 不新增独立生产文件，优先在 `tests/providers.test.ts` 中内置一个轻量 fake model server helper
- baseUrl 指向本地 `127.0.0.1:<port>`
- profile 使用一个测试专用 profile，例如：

```ts
{
  profileKey: "test-openai",
  apiFormat: "openai",
  upstreamApi: "responses",
  baseUrl: localBaseUrl,
  apiKeyEnv: "OPENAI_API_KEY",
  apiKey: "test-key",
  model: "gpt-5.4",
  codingPlanEnabled: false,
}
```

fake model server 的职责：

1. 接收 Pi 发出的模型请求
2. 返回一个稳定的 assistant 文本，例如：

```ts
"hello from fake pi model"
```

3. 响应形态以 `pi` 当前实际请求的最小兼容格式为准
4. 如 `pi` 默认走 streaming，则在测试中实现最小 SSE 响应；如可走非 streaming，则优先使用非 streaming 以降低维护成本

断言目标：

1. `events` 中能收到至少一个 `text`
2. `text` 包含 fake model 的固定回复
3. `events` 最终会收到 `result`
4. `result.sessionId` 指向真实存在的本地 session 文件

### 四、测试组织方式

优先保持现有测试文件结构，不额外拆太多文件：

1. `tests/providers.test.ts`
   - 保留现有 unit/contract 测试
   - 新增两个 `describe`：
     - `Pi MCP bridge integration`
     - `PiProvider smoke`

2. `tests/fixtures/fake-mcp-server.ts`
   - 只做可执行 fixture，不放断言逻辑

### 五、脚本工程化

当前只有：

```json
"scripts": {
  "start": "bun src/index.ts",
  "test": "bun test tests/*.test.ts"
}
```

建议补充：

```json
"scripts": {
  "start": "bun src/index.ts",
  "test": "bun test tests/*.test.ts",
  "test:providers": "bun test tests/providers.test.ts",
  "test:pi": "bun test tests/providers.test.ts tests/group-queue.test.ts tests/runtime.test.ts"
}
```

说明：

- `test:providers` 用于只回归 provider 层
- `test:pi` 用于回归本轮 Pi 迁移相关测试

### 六、落地原则

1. 先尽量只改测试，不改生产代码
2. 如果 `pi-mcp-extension` 或 `PiProvider` 当前实现确实不利于稳定测试，只允许做“无行为变化”的小幅重构
3. 所有新增测试都必须本地可跑，不依赖公网
4. 最终仍以 `bun test tests/*.test.ts` 作为总验证口径

## 预期修改示意

### 1. MCP fixture

文件：

- `tests/fixtures/fake-mcp-server.ts`

示意：

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "fake-mcp",
  version: "1.0.0",
});

server.tool(
  "echo_text",
  {
    text: z.string(),
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
  }),
);

await server.connect(new StdioServerTransport());
```

### 2. provider smoke test

文件：

- `tests/providers.test.ts`

示意：

```ts
test("PiProvider.startSession emits text and result with a local fake model server", async () => {
  const server = Bun.serve({
    fetch(req) {
      return Response.json({
        id: "resp_1",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello from fake pi model" }],
          },
        ],
      });
    },
  });

  const provider = new PiProvider(passthroughImagePreprocessor);
  const { events } = await provider.startSession(...);

  const collected = [];
  for await (const event of events) {
    collected.push(event);
  }

  expect(collected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "result" }),
    ]),
  );
});
```

## Todo List

### Phase 0: 方案确认
- [x] 确认本轮“工程化”范围仅包含测试护栏，不夹带运行时行为改动

### Phase 1: MCP 集成测试
- [x] 新建 `tests/fixtures/fake-mcp-server.ts`
- [x] 为 `createPiMcpExtensionBundle()` 增加真实 stdio MCP 集成测试
- [x] 覆盖 text content 与非 text content 的规范化结果

### Phase 2: Provider smoke test
- [x] 在 `tests/providers.test.ts` 中新增本地 fake model server
- [x] 为 `PiProvider.startSession()` 增加本地 smoke test
- [x] 验证 `AgentEvent.text`、`AgentEvent.result` 与本地 session 文件落盘

### Phase 3: 脚本与回归入口
- [x] 修改 `package.json`，增加 `test:providers`
- [x] 修改 `package.json`，增加 `test:pi`

### Phase 4: 验证
- [x] 运行 `bun test tests/providers.test.ts`
- [x] 运行 `bun test tests/*.test.ts`
