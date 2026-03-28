# MiniMax 文生图工具接入方案

## 问题描述

当前 Octo 已经具备两块与图片相关的基础能力：

1. Agent 可以通过 `send_image` 工具把**已有本地图片文件**发送到聊天群
2. 群组运行时已经接入 MiniMax 文本模型 profile，并且环境里已有 `MINIMAX_API_KEY`

但系统还缺一块关键能力：**Agent 不能自己生成图片**。  
这意味着当用户提出“画一张图”“生成一张海报”“根据描述出一张配图”这类需求时，Agent 只能给文本描述，不能直接产出可发送的图片资产。

本需求的目标是新增一个 **文生图工具**，让 Agent 可以：

1. 调用 MiniMax 官方图片生成接口完成文生图
2. 将生成结果直接保存到当前群组工作目录中
3. 把生成后的相对路径返回给 Agent
4. 由 Agent 继续复用现有 `send_image` 工具把图片发回群里

本次需求的非目标：

- 不实现图生图
- 不实现“生成并自动发送”的耦合式大工具
- 不把文生图能力绑死到当前群的 `agent_provider=minimax`
- 不在第一版暴露 MiniMax 文生图接口的全部参数

### 需求边界判断

本仓库里的 `minimax` profile 目前只用于 **Claude Agent SDK 的文本 Anthropic 兼容接口**，而 MiniMax 图片生成走的是另一条独立 HTTP API：

- 文本 Anthropic 兼容：`https://api.minimaxi.com/anthropic`
- 文生图接口：`POST https://api.minimaxi.com/v1/image_generation`

因此本需求不是“扩展现有 provider”，而是“新增一个由工具层直接调用的外部图片生成能力”。

### 参考资料

- 本地总览文档：`docs/minimax/api_overview.md`
- MiniMax 官方文生图 API：`https://platform.minimaxi.com/docs/api-reference/image-generation-t2i`
- MiniMax 官方图片生成指南：`https://platform.minimaxi.com/docs/guides/image-generation`

根据官方文档，文生图接口至少明确支持：

- `model`: `image-01` / `image-01-live`
- `prompt`
- `aspect_ratio`
- `response_format`: `url` / `base64`
- `n`
- `prompt_optimizer`
- `aigc_watermark`

官方指南同时给出了 `response_format = "base64"` 后从 `data.image_base64` 解码写出 `.jpeg` 文件的示例。  
对 Octo 来说，这种方式比 `url` 更合适，因为官方明确说明 URL 只有 24 小时有效期，而现有 `send_image` 工具需要稳定的本地文件路径。

## 对现有项目的影响

### 需要修改的文件

- `src/tools.ts`
- `README.md`
- `docs/octo.md`
- `tests/providers.test.ts`

### 需要新增的文件

- `src/runtime/minimax-image.ts`
- `tests/minimax-image.test.ts`

### 预计不需要修改的文件

- `src/providers/claude.ts`
- `src/group-queue.ts`
- `src/runtime/profile-config.ts`
- `config/agent-profiles.json`
- `config/agent-profiles.example.json`
- `env.example`

原因：

1. 文生图工具不依赖当前群的 `agent_provider`
2. `MINIMAX_API_KEY` 已经存在，不需要新增环境变量
3. 现有 `send_image` 已经能负责“发送图片”这一步

### 兼容性与风险

#### 1. 不应依赖当前群的 provider

即使当前群在使用 `claude`、`codex`、`kimi`，也应该能使用文生图工具。  
因此工具层必须直接读取 `process.env.MINIMAX_API_KEY`，而不是去读取当前群 profile 的解析结果。

#### 2. 不适合直接返回 URL

MiniMax 官方文档说明 `response_format = "url"` 的图片 URL 只有 24 小时有效。  
而 Octo 当前发送图片、后续复用图片、审计生成结果都更适合持久化本地文件，因此应固定使用 `response_format = "base64"`。

#### 3. 现有工具参数系统对复杂类型支持有限

`src/providers/claude.ts` 中 `jsonSchemaToZod()` 当前主要只覆盖了字符串和枚举。  
如果新工具直接暴露 `boolean` / `integer` / `object` 类型参数，会顺带扩大到 Claude SDK 工具参数转换器改造，超出本次需求的最小闭环。

因此第一版工具的参数设计应尽量保持为：

- 必填字符串
- 可选字符串枚举

像 `n`、`prompt_optimizer`、`aigc_watermark` 这类参数先在工具内部固定，不直接暴露给 Agent。

#### 4. 需要控制输出目录

生成后的图片必须落在当前群组目录内部，避免污染仓库根目录，也避免和 `send_image` 的路径校验冲突。

## 实施方案

### 一、总体设计

新增一个常驻于 `commonTools` 的工具：

```text
generate_image(prompt, model?, aspectRatio?)
  → 调 MiniMax 图片生成 API
  → 返回 base64
  → 落盘到 groups/<groupFolder>/.generated/images/
  → 返回相对路径
  → Agent 如需发群，再调用 send_image(chatJid, filePath)
```

这样拆分的优点：

1. “生成图片”和“发送图片”职责清晰
2. 生成出来的文件可复用、可检查、可重发
3. 不需要让 `generate_image` 重复实现 `send_image` 里已有的权限与通道分发逻辑

### 二、新增 MiniMax 图片生成运行时模块

新增文件：`src/runtime/minimax-image.ts`

职责：

1. 读取并校验 `MINIMAX_API_KEY`
2. 请求 MiniMax 文生图接口
3. 校验响应状态和返回字段
4. 把 base64 图片保存到群组目录
5. 返回生成结果元信息

建议类型：

```ts
export type MiniMaxImageModel = "image-01" | "image-01-live";

export type MiniMaxAspectRatio =
  | "1:1"
  | "16:9"
  | "4:3"
  | "3:2"
  | "2:3"
  | "3:4"
  | "9:16"
  | "21:9";

export interface GenerateMiniMaxImageParams {
  groupWorkdir: string;
  prompt: string;
  model: MiniMaxImageModel;
  aspectRatio: MiniMaxAspectRatio;
}

export interface GeneratedImageArtifact {
  model: MiniMaxImageModel;
  aspectRatio: MiniMaxAspectRatio;
  prompt: string;
  relativeFilePath: string;
  absoluteFilePath: string;
}

export async function generateMiniMaxImage(
  params: GenerateMiniMaxImageParams,
): Promise<GeneratedImageArtifact>;
```

核心请求形态：

```ts
const response = await fetch("https://api.minimaxi.com/v1/image_generation", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: params.model,
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio,
    response_format: "base64",
    n: 1,
    prompt_optimizer: false,
    aigc_watermark: false,
  }),
});
```

响应解析按官方指南处理：

```ts
const payload = await response.json() as {
  data?: { image_base64?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
};

const imageBase64 = payload.data?.image_base64?.[0];
```

### 三、图片文件落盘规则

为了兼容现有 `send_image` 的“相对当前群组目录”语义，生成结果统一写到：

```text
groups/<groupFolder>/.generated/images/
```

文件命名建议：

```text
<timestamp>-<uuid>.jpeg
```

例如：

```text
groups/main/.generated/images/1711872000000-7b5f3f0b.jpeg
```

这样做的原因：

1. 不把 prompt 暴露到文件名里，避免路径脏数据和隐私泄露
2. 不和人工文件冲突
3. 返回给 `send_image` 的相对路径稳定明确，例如：

```text
.generated/images/1711872000000-7b5f3f0b.jpeg
```

保存逻辑示意：

```ts
const outputDir = join(groupWorkdir, ".generated", "images");
mkdirSync(outputDir, { recursive: true });

const filename = `${Date.now()}-${crypto.randomUUID()}.jpeg`;
const absoluteFilePath = join(outputDir, filename);
writeFileSync(absoluteFilePath, Buffer.from(imageBase64, "base64"));

return {
  relativeFilePath: relative(groupWorkdir, absoluteFilePath),
  absoluteFilePath,
  ...
};
```

### 四、在工具层新增 `generate_image`

修改文件：`src/tools.ts`

将新工具加入 `commonTools`，使所有群都可以使用。

建议工具定义：

```ts
{
  name: "generate_image",
  description: "Generate an image from a text prompt using MiniMax, save it into the current group directory, and return the relative file path",
  schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt for the image" },
      model: {
        type: "string",
        enum: ["image-01", "image-01-live"],
        default: "image-01",
        description: "MiniMax image model"
      },
      aspectRatio: {
        type: "string",
        enum: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"],
        default: "1:1",
        description: "Output aspect ratio"
      }
    },
    required: ["prompt"]
  }
}
```

处理逻辑：

1. 解析 `groupWorkdir`
2. 校验 `model=image-01-live` 时不能使用 `21:9`
3. 调用 `generateMiniMaxImage()`
4. 返回一段清晰文本，包含相对路径和下一步提示

建议返回内容：

```json
{
  "ok": true,
  "model": "image-01",
  "aspectRatio": "1:1",
  "filePath": ".generated/images/1711872000000-7b5f3f0b.jpeg",
  "message": "Image generated successfully. Use send_image with this filePath to post it to the group."
}
```

这里故意不自动发送，原因是：

1. Agent 可能想先看生成结果路径，再决定是否发送
2. 复用现有 `send_image`，可以少做一层权限与通道判断
3. 生成工具保持纯粹，更容易测试

### 五、错误处理策略

第一版必须明确处理以下异常：

1. `MINIMAX_API_KEY` 缺失
2. HTTP 非 2xx
3. `base_resp.status_code !== 0`
4. `data.image_base64` 缺失或空数组
5. base64 解码失败
6. 落盘失败
7. `image-01-live + 21:9` 的本地参数校验失败

工具层返回值要尽量是 Agent 可读文本，而不是直接把原始异常抛成难读堆栈。

### 六、测试方案

#### 1. 新增 `tests/minimax-image.test.ts`

覆盖 `src/runtime/minimax-image.ts` 的核心行为：

- 请求 URL、Headers、Body 正确
- 固定使用 `response_format = "base64"` 和 `n = 1`
- 成功时能把 `data.image_base64[0]` 解码为 `.jpeg` 文件
- 返回值中的 `relativeFilePath` 位于 `.generated/images/`
- `MINIMAX_API_KEY` 缺失时抛出明确错误
- 接口返回异常状态时抛出明确错误
- `data.image_base64` 为空时抛出明确错误
- `image-01-live + 21:9` 被本地拦截

测试方式可以参考 `tests/feishu.test.ts` 的 `globalThis.fetch` mock 写法。

#### 2. 更新 `tests/providers.test.ts`

补一条最小工具层测试，确认 `createGroupToolDefs()` 的结果里包含：

- `generate_image`
- `send_image`

必要时也可以直接调用 `generate_image` handler，断言它会返回带相对路径的文本结果。

### 七、文档同步

需要更新：

- `README.md`
- `docs/octo.md`

文档需要明确：

1. Octo 现在支持通过 `generate_image` 工具调用 MiniMax 文生图
2. 文生图能力复用全局 `MINIMAX_API_KEY`
3. 生成的文件保存在当前群组目录内，发送时继续使用 `send_image`
4. 文生图工具与当前群 `agent_provider` 无关

## Todo List

- [x] 新增 `specs/minimax-text-to-image-tool.md` 并完成评审
- [x] 新增 `src/runtime/minimax-image.ts`，封装 MiniMax 文生图请求与落盘逻辑
- [x] 修改 `src/tools.ts`，新增 `generate_image` 工具
- [x] 新增 `tests/minimax-image.test.ts`，覆盖接口请求、响应解析、错误处理和落盘行为
- [x] 更新 `tests/providers.test.ts`，确认工具集包含 `generate_image`
- [x] 更新 `README.md`，说明文生图工具和使用方式
- [x] 更新 `docs/octo.md`，同步工具层与环境变量语义
- [x] 运行相关测试并确认全部通过
