# 飞书接收图片消息支持

## 问题说明

当前项目里，飞书通道对“发送图片”已经支持，但“接收图片”仍然缺失。

现状链路如下：

- `src/channels/feishu.ts`
  - `handleMessageEvent()` 只会调用 `extractTextContent(message)`
  - `extractFeishuMessageContent()` 仅处理 `text` 和 `post`
  - `message_type = "image"` 时会返回 `null`
  - 最终日志表现为 `Skipping non-text or empty message`
- `src/db.ts`
  - 消息仍然只以 `content TEXT` 的形式入库
- `src/router.ts`
  - Router 把数据库里的 `content` 字符串拼成 prompt
- `src/providers/claude.ts`
  - `makeUserMessage(content: string)` 只把字符串作为文本消息发给 Claude Agent SDK

这导致两个直接问题：

1. 用户在飞书里发图片时，通道层会直接丢弃该消息，数据库里没有记录，Router 也无法把图片带入上下文。
2. 即使通道层后续把图片下载到本地，如果 Provider 仍然只发送纯文本 prompt，Agent 也看不到图片像素内容，只能看到文字描述。

本次需求目标不是“给图片消息加一个占位文案”，而是：

1. 飞书 `image` 消息不再被通道层丢弃
2. 用户发送的图片会被下载到本地工作区
3. 图片消息能沿用现有消息累积/触发机制进入 Router
4. Claude Agent SDK 最终收到的用户消息包含真正的 `image` content block，而不是只有文件路径文本

## 对现有项目的影响

受影响的核心文件预计包括：

- `src/channels/feishu.ts`
- `src/providers/claude.ts`
- `src/channels/manager.ts` 或新增一个共享的消息分片 helper 文件
- `tests/feishu.test.ts`
- `tests/providers.test.ts`
- 补充一个新的共享 helper 测试文件

行为影响：

1. 飞书 `image` 消息将被入库，而不是被跳过。
2. 图片资源会被保存到工作区，例如 `media/<chatId>/<messageId>.<ext>`。
3. 数据库和 Router 仍然以字符串内容为主，不新增消息表结构。
4. Provider 在发送给 Claude Agent SDK 前，会把字符串中的 Markdown 图片转换成真正的图片 content block。
5. 对 OpenAI 兼容上游的 profile，不需要额外改代理层，因为当前 `src/runtime/openai-transform.ts` 已经支持把 Anthropic 风格 image block 转成 OpenAI 兼容格式。

明确不做的事：

- 不改 `messages` 表结构
- 不引入新的消息附件表
- 不把图片 base64 存进数据库
- 不扩展到文件、音频、视频资源，本次只处理飞书图片消息

风险点：

1. 飞书用户发送的图片不能用 `im.image.get` 下载，必须走 `im.message.resource.get`，调用参数不能搞错。
2. 下载下来的文件需要能稳定推断 MIME type，否则 Provider 构造 image block 时可能失败。
3. Provider 将文本 prompt 转成图文混合 content blocks 时，必须保留原有文本顺序，避免打乱上下文。
4. 图片文件如果丢失，不能让整个会话启动失败，至少要退化成文本提示。

## 实现方案

本次方案刻意选择最小改动路径：复用项目现有对 Markdown 图片语法的支持，把“接收图片”和“发送图片”在消息表示层统一成标准 Markdown。

这样可以避免大范围修改 `db.ts`、`router.ts`、`group-queue.ts` 的数据结构，同时不再引入新的自定义图片标记。

### 方案总览

链路调整后的形态：

1. 飞书收到 `image` 消息
2. 通道层解析出 `image_key`
3. 通过 `im.message.resource.get` 下载图片到 `media/...`
4. 将入库内容写成标准 Markdown 图片，例如：

```text
![image](media/oc_xxx/om_xxx.png)
```

5. `src/router.ts` 继续按现有逻辑把多条消息拼成字符串 prompt
6. `src/providers/claude.ts` 在真正调用 Claude Agent SDK 前，识别 prompt 中的 Markdown 图片
7. 把这段字符串拆成：
   - 文本 block
   - 图片 block
8. 最终通过 Claude Agent SDK 的 streaming input 发送图文混合消息

这样：

- DB 不需要理解“附件”
- Router 不需要改成结构化消息队列
- Active session 的 follow-up `push(text)` 也可以原样保留
- 只要字符串里带有 Markdown 图片，Provider 就能把它恢复成图片消息

### 1. 抽出共享的消息图片解析 helper

当前 `src/channels/manager.ts` 已经有一套图片片段识别逻辑：

- `OutgoingMessagePart`
- `parseOutgoingMessageParts()`
- 现状同时识别标准 Markdown 图片和 `[IMAGE:...]` 旧语法

这套能力目前只用于“发送阶段”。

本次建议把它提取成共享 helper，例如：

- `src/message-parts.ts`

导出类似接口：

```ts
export type MessagePart =
  | { type: "text"; value: string }
  | { type: "image"; value: string };

export function parseMessageParts(text: string): MessagePart[];
export function normalizeLegacyImageSyntax(text: string): string;
```

后续两个地方共用：

1. `src/channels/manager.ts`
   - 继续用于发送图片
2. `src/providers/claude.ts`
   - 用于把 prompt 中的 Markdown 图片解析成 Claude content blocks

设计原则：

- 正式的图片表示和解析规则统一为 Markdown 图片语法
- 接收侧新写入数据库的图片内容统一使用标准 Markdown 图片语法
- Provider 侧只解析 Markdown 图片，不承担旧语法兼容
- 发送侧为了兼容历史用法，仍接受 `[IMAGE:...]`，但方式是先归一化成 Markdown，再走统一解析

建议发送侧的归一化顺序如下：

1. `normalizeLegacyImageSyntax(text)`
2. `parseMessageParts(normalizedText)`

这样可以保证：

- 接收侧、Provider、发送侧的正式规则都是 Markdown
- 旧语法兼容只留在发送入口，不会扩散到整条消息链路

### 2. 在 `src/channels/feishu.ts` 中新增图片消息解析与下载

#### 2.1 识别 `message_type = "image"`

当前 `extractFeishuMessageContent()` 只处理：

- `text`
- `post`

需要扩展为：

- `text`：保持现有逻辑
- `post`：保持现有逻辑
- `image`：新增图片处理逻辑

但这里不建议把“图片处理”也塞进纯文本提取函数里。更合适的做法是把 `handleMessageEvent()` 拆成分支：

```ts
if (message.message_type === "image") {
  const content = await this.extractImageContent(message);
  ...
} else {
  const content = this.extractTextContent(message);
  ...
}
```

这样图片链路可以异步下载资源，不会把文本解析逻辑污染得过重。

#### 2.2 解析飞书图片消息内容

飞书接收事件中的 `message.content` 对图片消息应是 JSON 字符串，核心字段是 `image_key`。

建议新增小 helper，例如：

```ts
function extractImageKeyFromMessage(message: FeishuMessagePayload): string | null
```

逻辑：

1. `JSON.parse(message.content)`
2. 读取 `image_key`
3. 没有则返回 `null`

#### 2.3 下载用户发送的图片资源

这里不能复用现有：

- `im.image.get`

因为它只支持下载“当前应用自己上传的 message 图片”。

用户发送给机器人的图片，应该使用：

- `client.im.messageResource.get(...)`

建议新增 helper：

```ts
private async downloadIncomingImage(
  messageId: string,
  imageKey: string,
  chatId: string,
): Promise<string>
```

建议流程：

1. 调用：

```ts
await this.client.im.messageResource.get({
  path: {
    message_id: messageId,
    file_key: imageKey,
  },
  params: {
    type: "image",
  },
});
```

2. 读取返回 headers 中的 `content-type`
3. 根据 MIME type 推断扩展名：
   - `image/png` -> `.png`
   - `image/jpeg` -> `.jpg`
   - `image/webp` -> `.webp`
   - `image/gif` -> `.gif`
4. 创建目录：

```text
media/<chatId>/
```

5. 写入文件，例如：

```text
media/<chatId>/<messageId>.png
```

6. 返回“相对工作区根目录的路径”，例如：

```text
media/oc_xxx/om_xxx.png
```

这里选择“相对路径”而不是绝对路径，原因是：

1. 绝对路径写进数据库和日志里可读性差
2. 仓库整体移动位置后，相对路径更稳定
3. Provider 可以在运行时用 `process.cwd()` 或显式 root 来解析成绝对路径

#### 2.4 图片消息入库内容格式

图片下载成功后，不新增 DB 字段，直接把 `content` 写成标准 Markdown 图片：

```text
![image](media/oc_xxx/om_xxx.png)
```

这样对现有链路的意义是：

1. `insertMessage()` 无需改结构
2. `router.ts` 拼 prompt 的逻辑无需改结构
3. Active session follow-up 仍然是字符串
4. Provider 可以在最后一跳把 Markdown 图片还原成真正图片

下载失败时，不能直接丢消息，建议退化成：

```text
[图片下载失败:image_key=img_v3_xxx]
```

这样至少：

- 消息不会消失
- 日志和上下文里能看到有一张图没处理成功
- 后续排障时有 `image_key`

### 3. 在 `src/providers/claude.ts` 中把 Markdown 图片转成 Claude 图片 block

这是这次改造的关键步骤。

如果只把图片下载到本地，但 `makeUserMessage()` 仍然返回：

```ts
message: { role: "user", content: "..." }
```

那么 Agent 看到的仍然只是字符串，不是图片。

Claude Agent SDK 的 streaming input 本身支持：

```ts
content: [
  { type: "text", text: "..." },
  {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "..."
    }
  }
]
```

因此建议重构 `makeUserMessage()`，让它支持两种模式：

1. 没有 Markdown 图片时
   - 保持当前实现，直接发送字符串
2. 包含 Markdown 图片时
   - 调用共享 helper 拆成 `text/image` 片段
   - 文本片段转成 `{ type: "text", text }`
   - 图片片段读取本地文件并转成 `{ type: "image", source: ... }`

建议新增 helper，例如：

```ts
function buildClaudeMessageContent(
  text: string,
  rootDir: string,
): string | Array<{ type: "text"; text: string } | { type: "image"; source: ... }>
```

处理步骤：

1. `parseMessageParts(text)`
2. 遍历片段
3. `text` 片段：
   - 原样保留，不要额外 trim，避免破坏 Router 拼出来的时间戳和换行
4. `image` 片段：
   - 用 `rootDir + relativePath` 解析绝对路径
   - 读取文件
   - 根据扩展名推断 MIME type
   - `Buffer.toString("base64")`
   - 构造 Claude image source

失败兜底策略：

如果图片文件不存在或读取失败，不建议抛错中断整轮会话，而应该降级成文本块，例如：

```text
[图片读取失败: media/...]
```

这样可以保证：

- 一张图片丢失不会让整批消息都无法触发 Agent
- 出问题时上下文仍可见

#### 3.1 `makeUserMessage()` 的建议形态

可以改成类似：

```ts
function makeUserMessage(
  content: string,
  rootDir: string,
): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: buildClaudeMessageContent(content, rootDir),
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}
```

`startSession()` 中初始 prompt 和 follow-up `push()` 都继续传字符串，不改 `SessionConfig` 和 `AgentSession` 接口。

这也是本方案尽量压缩影响面的关键。

### 4. Router、GroupQueue、DB 不做结构升级

本次明确保持以下模块结构不变：

- `src/db.ts`
- `src/router.ts`
- `src/group-queue.ts`
- `src/providers/types.ts`

原因：

1. 现有系统已经以“字符串消息累积 + 触发后整批拼 prompt”为核心工作方式
2. 用 Markdown 图片语法可以把图片能力嵌入这条既有链路
3. 如果把消息结构全面升级成 block/attachment，会扩散到：
   - DB schema
   - Router
   - Queue
   - Provider interface
   - 多个测试桩
4. 这次需求只要求飞书 channel 支持接收图片，没有必要把整个消息中台重做一遍

### 5. 测试方案

需要覆盖三类风险：飞书下载、Markdown 图片解析、Provider 图文转换。

#### 5.1 `tests/feishu.test.ts`

建议新增或补充以下场景：

1. 图片消息能从 `message.content` 中提取出 `image_key`
2. 下载 helper 能正确调用 `im.messageResource.get(...)`
3. 根据返回 header 的 `content-type` 生成正确扩展名
4. 下载成功后返回：

```text
![image](media/...)
```

5. 下载失败时返回带 `image_key` 的降级文本，而不是直接抛错吞消息

为了便于测试，建议把“解析图片 key”“根据 MIME 推断扩展名”“生成 Markdown 图片内容”等逻辑拆成可单测的纯函数，或通过 `__test__` 导出 helper。

#### 5.2 `tests/providers.test.ts`

建议覆盖：

1. 普通纯文本 prompt 仍走旧路径，`content` 保持 string
2. 包含 `![image](relative/path.png)` 的 prompt 会转成 content blocks
3. text 和 image block 的顺序不变
4. 图片文件缺失时，Provider 会降级为文本块而不是抛错

#### 5.3 共享 helper 测试

如果把 `parseOutgoingMessageParts()` 抽到共享文件，需要保留原有发送侧行为测试，确保：

1. `ChannelManager.send()` 的图片拆分逻辑不回归
2. 新共享 helper 对 Markdown 图片的解析结果与现有发送逻辑一致
3. `normalizeLegacyImageSyntax()` 能把 `[IMAGE:...]` 旧语法稳定转换成 Markdown
4. `ChannelManager.send()` 仍兼容 `[IMAGE:...]` 旧语法，避免历史输出立刻失效

## 实现细节建议

### 建议新增/调整的 helper

建议把以下 helper 抽清楚，避免所有逻辑都堆在一个函数里：

- `parseMessageParts(text)`
- `normalizeLegacyImageSyntax(text)`
- `extractImageKeyFromMessage(message)`
- `inferImageExtension(contentType)`
- `inferImageMimeTypeFromPath(filePath)`
- `downloadIncomingImage(messageId, imageKey, chatId)`
- `buildClaudeMessageContent(text, rootDir)`

### 建议的本地存储目录

建议固定为：

```text
media/
```

理由：

1. 作为独立媒体目录，路径更短，日志和 Markdown 中更可读
2. 不依赖 group 是否已注册
3. 第一条来自新 chat 的图片消息也可以先落盘，再走现有 auto-register

### 为什么不把图片存进 `groups/<folder>/`

因为通道层处理消息时，还不能保证当前 `chatId` 已经映射到 group folder：

- `insertMessage(db, message)` 先执行
- `autoRegisterChat(message.chatId)` 后执行

如果通道层强依赖 group folder，会把“首条图片消息触发自动建群”的路径变复杂。

因此把接收资源先存到 `media/<chatId>/` 是更稳妥的选择。

## Todo List

- [x] 抽出共享的消息图片解析 helper，供发送侧和 Provider 共用
- [x] 增加发送侧旧语法归一化 helper，把 `[IMAGE:...]` 转成 Markdown 图片
- [x] 在 `src/channels/feishu.ts` 中新增飞书 `image` 消息识别逻辑
- [x] 在 `src/channels/feishu.ts` 中新增基于 `im.messageResource.get` 的图片下载 helper
- [x] 将下载后的图片以 Markdown 图片形式写入消息 `content`
- [x] 将图片文件统一落盘到 `media/<chatId>/<messageId>.<ext>`
- [x] 为图片下载失败场景增加降级文本，避免消息被直接丢弃
- [x] 在 `src/providers/claude.ts` 中把 Markdown 图片 prompt 解析成 Claude image content blocks
- [x] 保持发送侧以 Markdown 图片为正式规则，同时通过归一化兼容 `[IMAGE:...]` 旧用法
- [x] 保持纯文本 prompt 的现有行为不变
- [x] 新增或更新测试，覆盖飞书图片下载、Markdown 图片解析、Provider 图文转换
- [x] 运行相关测试并确认通过
