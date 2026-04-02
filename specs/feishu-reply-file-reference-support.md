# 飞书引用文件消息支持

## 问题说明

当前项目已经支持两条基础能力：

1. 飞书用户直接发送 `file` 消息时，通道层会下载文件并把消息内容保存成 Markdown 文件链接。
2. Agent 在 `send_message` 中输出 Markdown 文件链接时，飞书通道可以把本地文件重新作为附件发送出去。

但在“回复 / 引用文件消息”的场景里仍有一个关键缺口：

1. 用户在飞书里对一条 PDF / 文件消息点击“回复”，再发送 `帮我转成Markdown`。
2. 飞书推送给机器人的是一条新的 `text` 消息。
3. 这条新消息里只包含当前文本，以及 `parent_id` / `root_id`。
4. 当前 `src/channels/feishu.ts` 只解析这条新文本本身，不会根据 `parent_id` 去还原被引用的原始文件消息。
5. 结果就是 Router / Agent 只能看到“帮我转成Markdown”，看不到被引用的 PDF 路径，最终表现为机器人要求用户重新提供文件路径，或者错误地按普通文本处理。

从日志可以确认这个问题已经在线上出现：

1. 原始文件消息是 `message_type = "file"`，并且已经正确入库成：

```md
[费率表-门急诊医疗.pdf](media/oc_c921874a79447e21b28e7fee2cc52983/om_x100b53e8bf59b8a0c45ab836a307c5e-费率表-门急诊医疗.pdf)
```

2. 之后的引用回复消息是 `message_type = "text"`，只包含：

```json
{
  "text": "@_user_1 帮我转成Markdown",
  "parent_id": "om_x100b53e8bf59b8a0c45ab836a307c5e",
  "root_id": "om_x100b53e8bf59b8a0c45ab836a307c5e"
}
```

因此这不是 MarkItDown skill 本身的问题，而是飞书通道没有把“引用的原始文件消息”重新补回当前上下文。

结合仓库内文档 `docs/feishu`，本次方案还基于以下已确认事实：

1. [`docs/feishu/message_event.md`](/Users/wmeng/work/kkdashu/octo/docs/feishu/message_event.md) 明确说明，`im.message.receive_v1` 事件在回复场景下会带 `root_id` 与 `parent_id`。
2. [`docs/feishu/receive_message_info.md`](/Users/wmeng/work/kkdashu/octo/docs/feishu/receive_message_info.md) 说明：
   - 接收 / 查询消息时，`content` 都是 JSON 字符串。
   - `file` 类型消息的内容结构是 `{ "file_key": "...", "file_name": "..." }`。
3. [`docs/feishu/message.md`](/Users/wmeng/work/kkdashu/octo/docs/feishu/message.md) 说明：
   - 可以通过 `GET /open-apis/im/v1/messages/:message_id` 获取指定消息内容。
   - 可以通过 `GET /open-apis/im/v1/messages/:message_id/resources/:file_key` 下载消息中的资源文件。
4. [`docs/feishu/get_message_resource.md`](/Users/wmeng/work/kkdashu/octo/docs/feishu/get_message_resource.md) 明确说明：
   - 下载用户发送给机器人的文件，应走 `message resource` 接口。
   - `type=file` 适用于文件、音频、视频。
   - `message_id` 与 `file_key` 必须匹配。
   - 仅支持 100 MB 以内资源。

本次需求目标是：

1. 当飞书消息携带 `parent_id`（必要时回退 `root_id`）时，机器人能够获取被引用的原始消息。
2. 如果被引用的原始消息是 `file`，则沿用现有文件下载与 Markdown file 链接生成逻辑。
3. 将“引用文件”上下文并入当前文本消息内容，让 Router / Agent 在单条消息里就能看到被引用文件。
4. 用户在群里直接回复 PDF 并说“帮我转成Markdown”时，不需要再手动提供文件路径。

本次明确不做的事：

- 不修改数据库表结构
- 不修改 Router 游标逻辑
- 不新增新的飞书工具或消息类型
- 不在这一轮同时扩展“引用图片消息”“引用 post 富文本消息”“引用卡片消息”
- 不在这一轮改变 skill 触发规则

## 对现有项目的影响

预计受影响文件：

- `src/channels/feishu.ts`
- `tests/feishu.test.ts`

可能新增但非必须的内部类型：

- `src/channels/feishu.ts` 内部 `type FeishuQuotedMessagePayload`
- `src/channels/feishu.ts` 内部 `type FeishuMessageGetClient`

行为变化：

1. 对文件消息的“直接发送”行为不变。
2. 对普通文本消息的处理行为不变。
3. 当一条飞书文本消息带有 `parent_id` 时，通道层会尝试获取被引用消息。
4. 若被引用消息是 `file`，当前消息的最终 `content` 会被增强，包含该文件的 Markdown 本地路径。
5. 若拉取引用消息失败、被引用消息不是 `file`、或其内容不合法，则保持现有文本消息行为，不阻断当前消息入库。

风险点：

1. `parent_id` 指向的消息可能已被删除、不可见，或机器人无权限读取，不能让整条当前消息处理失败。
2. 如果每次引用都重新下载文件，可能产生重复文件，但第一阶段优先保证功能正确；是否做本地复用可后续优化。
3. 引用消息增强后的文本格式需要稳定，否则可能影响 skill 对 Markdown 文件链接的识别。
4. Feishu SDK 的 `im.v1.messages.get` 返回结构与 webhook 事件结构不完全一致，需要在通道层做一次标准化映射。
5. 飞书文档确认 `message resource` 接口不支持卡片消息和合并转发子消息，因此引用解析只针对标准 `file` 消息做首轮支持。

## 实现方案

### 方案总览

在当前“接收飞书消息”的链路中，增加一层“引用消息解析”：

1. 收到 webhook 消息后，先按现有逻辑解析当前消息正文。
2. 若当前消息存在 `parent_id`，调用飞书消息查询接口拉取被引用消息。
3. 若 `parent_id` 不存在但 `root_id` 存在，则用 `root_id` 作为兜底。
4. 若被引用消息是 `file`，复用现有 `extractFileContent()` 逻辑，把原始文件下载成本地 Markdown file 链接。
5. 将该 Markdown file 链接拼接到当前文本内容前面，形成增强后的单条消息内容。
6. Router、skill、provider 不需要知道飞书引用消息细节，继续只消费增强后的字符串。

### 1. 为飞书消息补充引用字段读取

当前 `handleMessageEvent()` 只读取：

```ts
const { message, sender } = event;
const content = await this.extractIncomingContent(message);
```

需要让 `extractIncomingContent()` 能访问 `parent_id` / `root_id`，因此保留传入完整的 `message` 对象，并在其内部增加引用解析分支。

建议在 `src/channels/feishu.ts` 中把消息形状补充为：

```ts
type FeishuIncomingMessagePayload = {
  message_id?: string;
  chat_id?: string;
  message_type?: string;
  content?: string;
  mentions?: unknown;
  parent_id?: string;
  root_id?: string;
};
```

同时新增一个安全读取引用消息 ID 的 helper：

```ts
function readQuotedMessageId(
  message: FeishuIncomingMessagePayload,
): string | null
```

规则：

1. 优先使用 `parent_id`
2. `parent_id` 为空时回退 `root_id`
3. 去掉空白字符
4. 若结果与当前 `message_id` 相同，则视为无效引用，避免自引用死循环

### 2. 增加“查询被引用消息”的 Feishu client 包装

当前代码已经使用：

- `this.client.im.messageResource.get(...)` 下载图片 / 文件资源

本次需要增加：

- `this.client.im.message.get({ path: { message_id } })`

建议新增内部类型，避免直接在逻辑里散落 `unknown`：

```ts
type FeishuMessageGetClient = {
  get: (payload: {
    path: {
      message_id: string;
    };
  }) => Promise<{
    data?: {
      items?: Array<Record<string, unknown>>;
    };
  }>;
};
```

这里要特别注意：根据 `docs/feishu/receive_message_info.md`，查询接口返回的单条消息结构不是 webhook 的 `message_type/content`，而是：

```json
{
  "message_id": "om_xxx",
  "chat_id": "oc_xxx",
  "msg_type": "file",
  "body": {
    "content": "{\"file_key\":\"file_xxx\",\"file_name\":\"report.pdf\"}"
  }
}
```

因此 `fetchReferencedMessage(...)` 不能直接把查询结果原样传给 `extractFileContent()`，而是必须先标准化为当前通道内部统一结构：

```ts
{
  message_id,
  chat_id,
  message_type: msg_type,
  content: body.content,
}
```

并新增 helper：

```ts
async function fetchReferencedMessage(
  messageClient: FeishuMessageGetClient,
  messageId: string,
): Promise<FeishuIncomingMessagePayload | null>
```

处理原则：

1. 查询失败时只记日志，返回 `null`
2. 若返回体为空、`items` 为空、或缺少 `message_id / message_type`，返回 `null`
3. 将接口返回的 `msg_type/body.content` 映射到当前 webhook 处理所需的 `message_type/content`
4. 仅保留 `message_id`、`chat_id`、`message_type`、`content` 这些后续解析真正需要的字段

### 3. 复用现有文件解析逻辑，不新增第二套下载链路

当前 `extractIncomingContent()` 已经支持：

```ts
if (message?.message_type === "file") {
  return this.extractFileContent(message);
}
```

因此不要为“引用文件消息”重写一套下载逻辑，而是新增一层包装：

```ts
private async resolveReferencedFileContent(
  message: FeishuIncomingMessagePayload,
): Promise<string | null>
```

内部流程：

1. 从当前文本消息中拿到被引用消息 ID
2. 调用 `fetchReferencedMessage(...)`
3. 若被引用消息不是 `file`，返回 `null`
4. 若被引用消息是 `file`，直接调用现有 `extractFileContent(referencedMessage)`
5. 返回生成好的 Markdown 文件链接，例如：

```md
[费率表-门急诊医疗.pdf](media/oc_xxx/om_xxx-费率表-门急诊医疗.pdf)
```

这样可以保证：

1. 文件下载目录规则保持一致
2. 文件名清洗逻辑保持一致
3. 错误诊断日志保持一致
4. 后续若 `extractFileContent()` 继续演进，引用场景自动受益

### 4. 定义增强后的消息内容格式

为了让 Router / Agent 在不理解飞书引用结构的前提下仍然正确工作，建议将增强后的内容格式固定为：

```md
引用文件：
[费率表-门急诊医疗.pdf](media/oc_xxx/om_xxx-费率表-门急诊医疗.pdf)

当前消息：
@octo 帮我转成Markdown
```

拼接规则：

1. 只有在成功解析出“被引用文件 Markdown 链接”时才使用增强格式
2. 如果当前文本为空，则只保留：

```md
引用文件：
[费率表-门急诊医疗.pdf](media/oc_xxx/om_xxx-费率表-门急诊医疗.pdf)
```

3. 如果引用解析失败，则回退到当前 `extractTextContent(message)` 的结果

建议新增 helper：

```ts
function buildReferencedFileMessageContent(params: {
  referencedFileMarkdown: string;
  currentText: string | null;
}): string
```

设计原因：

1. 明确区分“引用文件”和“当前指令”，利于模型理解
2. 文件路径仍以标准 Markdown file 语法出现，现有 PDF-to-Markdown skill 无需额外改 prompt 解析
3. 即便后续 provider 对 Markdown 文件做本地展开，也可以直接复用现有能力

### 5. 调整 `extractIncomingContent()` 的执行顺序

当前逻辑是按消息类型直接分派。改造后建议对 `text` 消息增加特殊分支：

```ts
private async extractIncomingContent(
  message: FeishuIncomingMessagePayload,
): Promise<string | null> {
  if (message?.message_type === "image") {
    return this.extractImageContent(message);
  }

  if (message?.message_type === "file") {
    return this.extractFileContent(message);
  }

  if (message?.message_type === "post") {
    return this.extractPostContent(message);
  }

  if (message?.message_type === "text") {
    const currentText = this.extractTextContent(message);
    const referencedFileMarkdown = await this.resolveReferencedFileContent(message);
    return referencedFileMarkdown
      ? buildReferencedFileMessageContent({
          referencedFileMarkdown,
          currentText,
        })
      : currentText;
  }

  return this.extractTextContent(message);
}
```

这个顺序有两个目的：

1. 不影响现有图片、文件、post 的专用处理
2. 只在文本消息里做“引用文件增强”，与飞书当前 webhook 实际行为匹配

### 6. 测试方案

需要在 `tests/feishu.test.ts` 中新增至少以下测试：

1. `readQuotedMessageId()`：
   - 优先返回 `parent_id`
   - `parent_id` 缺失时回退 `root_id`
   - 空字符串返回 `null`
   - 与当前 `message_id` 相同则返回 `null`

2. `buildReferencedFileMessageContent()`：
   - 同时包含引用文件与当前文本
   - 当前文本为空时仅输出引用文件段落

3. `fetchReferencedMessage()`：
   - 能从 `im.message.get` 响应中提取出最小消息结构
   - 空响应时返回 `null`

4. `extractIncomingContent()` 引用文件分支：
   - 当前消息为 `text`，带 `parent_id`
   - mock `im.message.get` 返回 `file` 消息
   - mock `messageResource.get` 下载成功
   - 断言最终 `content` 包含 Markdown 文件链接与当前文本

5. 容错分支：
   - 引用查询失败时，仍返回当前文本
   - 引用消息不是 `file` 时，仍返回当前文本

## Todo List

- [x] 新增 `specs/feishu-reply-file-reference-support.md`，明确引用文件消息的处理范围与方案
- [x] 在 `src/channels/feishu.ts` 中补充 `parent_id` / `root_id` 读取逻辑
- [x] 在 `src/channels/feishu.ts` 中新增飞书引用消息查询 helper，并封装 `im.message.get`
- [x] 在 `src/channels/feishu.ts` 中新增“引用文件内容增强”逻辑，复用现有 `extractFileContent()`
- [x] 在 `src/channels/feishu.ts` 中定义稳定的增强后消息内容格式
- [x] 为引用文件 ID 解析、引用消息内容构建、引用文件回填主流程补充单元测试
- [x] 运行相关测试并确认不回归现有文件消息能力
