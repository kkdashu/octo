# 飞书 text 消息 mention 显示名归一化

## 问题说明

当前飞书 `text` 消息的正文提取逻辑直接读取 `message.content` 里的 `text` 字段，并原样入库。

对于包含 `@` 提及的飞书消息，`text` 字段里通常不是最终显示名，而是类似 `@_user_1` 这样的占位符；真正的显示名位于 `message.mentions` 数组中，例如：

- `mentions[i].key = "@_user_1"`
- `mentions[i].name = "octo"`

这会导致：

1. Router 和 Agent 看到的上下文正文是 `@_user_1 ...`，而不是 `@octo ...`
2. 模型会把消息理解成“用户在呼叫另一个用户”，而不是在呼叫机器人
3. 即使 `mentionsMe` 为真，模型仍可能基于正文做出错误推断，回复“不应该插话”

本次修复范围只限于：

- 在飞书 `text` 消息解析阶段，将正文中的 `mentions[].key` 替换为 `@name`
- 不修改 trigger 判定逻辑
- 不修改 `mentionsMe` 的判断逻辑
- 不修改 `post` 消息提取逻辑

## 对现有项目的影响

受影响文件：

- `src/channels/feishu.ts`
- `tests/feishu.test.ts`

行为变化：

- 飞书 `text` 消息中，若包含 mention 占位符，例如 `@_user_1`，会在入库前被替换为对应显示名，例如 `@octo`
- Router 拼接给 Agent 的上下文会更接近用户在飞书客户端里实际看到的文案
- 不包含 mention 的普通文本消息保持原行为

不变项：

- `message.mentions` 仍只用于辅助替换正文显示
- `mentionsMe` 的现有逻辑保持不变
- `post` 消息仍按现有 `renderPostElement(tag === "at")` 逻辑处理

风险点：

1. `mentions[].name` 可能为空，或某些 mention 只有 `key` 没有可用显示名
2. 同一条消息可能包含多个 mention，需要稳定地逐个替换
3. `key` 中包含正则特殊字符时，替换实现不能误伤其它文本

## 实现方案

### 1. 在 `text` 消息提取逻辑中引入 mention 归一化

当前实现位于：

- `src/channels/feishu.ts`

现状：

```ts
function extractTextMessageContent(message: FeishuMessagePayload): string | null {
  const parsed = parseFeishuMessageContent(message) as Record<string, unknown> | null;
  const text = typeof parsed?.text === "string" ? parsed.text : "";
  return normalizeExtractedContent(text);
}
```

计划改为：

1. 从 `parsed.text` 取出原始文本
2. 读取 `message.mentions`
3. 对每个 mention：
   - 若 `key` 是字符串
   - 且 `name` 是非空字符串
   - 则把正文中的 `key` 替换为 `@name`
4. 最后再执行 `normalizeExtractedContent`

建议新增一个小的纯函数，例如：

- `replaceMentionKeysWithNames(text, mentions)`

这样可以把正文提取与替换规则分开，测试也更直接。

### 2. 替换规则细节

替换策略：

- 输入：`"@_user_1 使用adb命令查询一下你连接了哪些手机"`
- mention：`{ key: "@_user_1", name: "octo" }`
- 输出：`"@octo 使用adb命令查询一下你连接了哪些手机"`

实现约束：

- 使用字符串安全替换，不依赖不必要的复杂正则
- 仅替换 `mentions` 中显式提供的 `key`
- 若 `name` 为空，则保留原始 `key`
- 若同一条消息有多个 mention，则按 `mentions` 顺序全部替换

### 3. 测试覆盖

在 `tests/feishu.test.ts` 中补充或更新以下场景：

1. `text` 消息无 mention 时，结果保持不变
2. `text` 消息包含单个 mention 时，`@_user_1` 被替换为 `@octo`
3. `text` 消息包含多个 mention 时，多个占位符都能被替换
4. mention 缺少 `name` 时，不进行替换

## Todo List

- [x] 在 `src/channels/feishu.ts` 中为 `text` 消息添加 mention key 到显示名的替换逻辑
- [x] 保持现有 `normalizeExtractedContent` 与 `post` 消息逻辑不变
- [x] 在 `tests/feishu.test.ts` 中补充 `text` mention 替换测试
- [x] 运行相关测试并确认通过
