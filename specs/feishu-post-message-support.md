# 飞书富文本消息兼容

## 问题说明

当前项目在接收飞书消息时，只处理 `message_type = "text"` 的消息。实现位于：

- `src/channels/feishu.ts`

现状是：

- 普通文本消息会被解析并入库
- 富文本消息，例如飞书 `post` 类型消息，会在通道层直接被跳过
- 一旦用户先发送一条 `post` 富文本需求，再用一条 `@机器人` 文本消息触发 AI，Router 只能看到后者，无法把前一条富文本消息作为上下文传给 Agent

这会导致一种明显错误行为：

1. 用户在群里发带格式的需求说明，例如多段落、代码块、富文本说明
2. 系统日志出现 `Skipping non-text or empty message`
3. 后续触发消息虽然能启动 Agent，但上下文缺失，AI 只能看到“帮我做上面那个需求”，看不到真正的需求内容

因此需要兼容飞书 `post` 消息，把它提取为可入库的纯文本上下文。

## 对现有项目的影响

受影响的模块和文件：

- `src/channels/feishu.ts`
- 可能新增测试文件，例如 `tests/feishu.test.ts`
- 如有必要，补充 `README.md` 或项目文档对消息兼容范围的说明

行为影响：

- 飞书 `post` 类型消息不再被直接丢弃
- `post` 中的文本、代码块等内容会被提取并拼成纯文本，进入 `messages` 表
- Router 在后续触发时，可以把这些富文本消息一起作为上下文发给 Agent
- `mentionsMe` 逻辑仍保持现有行为，不依赖正文提取结果

风险点：

- 飞书 `post.content` 是嵌套结构，解析规则如果设计得太随意，可能导致段落合并混乱或代码块丢失换行
- `post` 里可能包含图片、链接卡片、表情、at、todo 等多种 tag，需要明确哪些支持文本化，哪些忽略
- 如果提取规则不稳定，可能导致同一条消息在上下文里可读性很差，反而影响 Agent 理解

## 实现方案

目标不是完整渲染飞书富文本，而是把 `post` 消息稳定地降级成对 Agent 有用的纯文本。

### 方案原则

1. 优先保证信息不丢，尤其是自然语言正文和代码块。
2. 输出结果必须稳定、可预测，避免不同消息结构下格式完全失控。
3. 保持最小改动面，优先只修改 `FeishuChannel` 的内容提取逻辑。
4. 先支持常见 `post` 结构：文本段、代码块、段落换行；不追求一次覆盖全部飞书富文本组件。

### 1. 扩展 `extractTextContent()` 的消息类型支持

当前逻辑：

- `message_type !== "text"` 直接返回 `null`

需要改为：

- `text`：保持现有解析方式
- `post`：解析 `message.content` JSON 中的富文本结构
- 其他类型：仍返回 `null`

建议改成分发式实现：

```ts
private extractTextContent(message: any): string | null {
  if (message.message_type === "text") {
    return this.extractTextMessageContent(message);
  }

  if (message.message_type === "post") {
    return this.extractPostMessageContent(message);
  }

  return null;
}
```

### 2. 为 `post` 增加结构化文本提取

飞书 `post` 的典型结构类似：

```json
{
  "title": "",
  "content": [
    [
      { "tag": "text", "text": "第一段" }
    ],
    [
      { "tag": "code_block", "language": "PLAIN_TEXT", "text": "..." }
    ]
  ]
}
```

建议按“行”和“块”两个层级处理：

- `content` 外层数组视为多行 / 多段
- 每一行内的元素顺序拼接
- 行与行之间用换行符 `\n` 分隔
- `code_block` 单独保留代码文本，并尽量用 fenced code block 形式输出，提升上下文可读性

建议支持的 tag：

- `text` → 直接取 `text`
- `code_block` → 输出为：
  ```text
  ```LANG
  code
  ```
  ```
  若语言为空，则退化为普通 fenced block
- `a` / 链接类 → 可优先取显示文本，没有则取 href/url
- `at` → 优先输出显示名，例如 `@octo`

建议先忽略的 tag：

- 图片
- 表情
- 分割线
- 卡片类富组件

忽略时不报错，只是不输出对应内容。

### 3. 增加规范化步骤，避免脏格式

为了让存入数据库的内容更稳定，建议在 `post` 提取后做一层轻量规范化：

- 去掉首尾空白
- 连续空行压缩为最多两行
- 全部提取结果为空时返回 `null`

这样可以避免富文本里夹杂空节点时，数据库里存一堆空白字符串。

### 4. 保持 Router 和数据库层不变

这次问题不在 Router 和数据库：

- `insertMessage()` 已经能存任意字符串文本
- `Router` 已经会把“未触发但已入库”的消息累积为上下文

所以只要 `FeishuChannel` 成功把 `post` 提取成 `content` 并走到 `onMessage`，现有链路就会自动生效。

这也是为什么本次改动应集中在通道层，而不需要扩散到 `router.ts` 或 `db.ts`。

### 5. 增加测试覆盖

当前仓库没有飞书通道测试，建议新增测试文件，例如：

- `tests/feishu.test.ts`

建议覆盖以下场景：

1. `text` 消息仍能正常提取
2. `post` 消息中的多段纯文本能按段落拼接
3. `post` 消息中的 `code_block` 能保留代码内容和换行
4. `post` 消息如果只有不支持的 tag，返回 `null`
5. 非法 JSON 内容返回 `null`

如果不方便直接测试私有方法，可以：

- 抽出纯函数到同文件导出测试辅助
- 或在 `FeishuChannel` 文件中导出一个仅供测试使用的解析 helper

建议优先使用纯函数，因为这类解析逻辑本质上是数据转换，不需要绑在 Channel 实例上。

## 实现细节建议

建议在 `src/channels/feishu.ts` 内新增几个小函数，降低 `extractTextContent()` 复杂度：

- `extractTextMessageContent(message)`
- `extractPostMessageContent(message)`
- `renderPostParagraph(paragraph)`
- `renderPostElement(element)`
- `normalizeExtractedContent(text)`

这样后面如果还要兼容更多飞书 tag，不会把一个函数堆得太大。

## Todo List

- [x] 梳理飞书 `text` 与 `post` 消息结构的差异
- [x] 重构 `src/channels/feishu.ts` 的消息正文提取逻辑
- [x] 为 `post` 类型实现文本 / 代码块提取
- [x] 增加提取结果规范化逻辑
- [x] 新增或更新测试，覆盖 `text` 和 `post` 两类消息
- [x] 运行相关测试，确认 `post` 消息不再被通道层丢弃
