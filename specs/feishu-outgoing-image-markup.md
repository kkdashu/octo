# 飞书发送阶段图片标记解析

## 问题说明

当前系统在发送消息时，无论内容里是否包含图片标记，都会把整段内容当作纯文本发送。

现有链路里，Agent 的回复和 `send_message` 工具最终都会走：

- `src/group-queue.ts` → `channelManager.send(group.jid, event.text)`
- `src/tools.ts` → `sender.send(chatJid, text)`
- `src/channels/manager.ts` → `channel.sendMessage(chatJid, text)`

这意味着当 Agent 输出如下内容时：

```text
当前画面：

[IMAGE:/tmp/screen_unlock.png]

需要我做什么其他操作吗？
```

或标准 Markdown 图片：

```markdown
当前画面：

![screen](/tmp/screen_unlock.png)
```

系统目前只会把图片标记原样发到飞书，无法调用飞书图片接口发送真实图片消息。

你的需求是：发送消息时需要解析消息格式，如果内容里是 Markdown 图片，就调用飞书接口发送图片消息。

补充说明：

- 你给的示例文本里实际使用的是自定义图片标签 `[IMAGE:/tmp/xxx.png]`
- 为了兼容当前已有 Agent 输出和你提到的 Markdown 图片，我计划统一支持两种图片标记：
  1. `[IMAGE:/abs/path.png]`
  2. `![alt](/abs/path.png)`

如果你只想支持标准 Markdown 图片、不想兼容 `[IMAGE:...]`，我可以在实现前把方案收窄。

## 对现有项目的影响

受影响文件：

- `src/channels/manager.ts`
- 可能新增一个发送阶段的解析 helper（放在 `src/channels/manager.ts` 同文件或新建小工具文件）
- 新增测试文件，例如 `tests/channel-manager.test.ts`

行为变化：

1. 普通纯文本消息仍按原样发送
2. 若文本中包含图片标记，则发送链路会按顺序拆分成“文本块 / 图片块”
3. 文本块继续调用 `sendMessage`
4. 图片块调用 channel 的 `sendImage`
5. 文本与图片的顺序保持一致

典型发送顺序示例：

输入：

```text
当前画面：

[IMAGE:/tmp/screen_unlock.png]

需要我做什么其他操作吗？
```

发送结果：

1. 发送文本：`当前画面：`
2. 发送图片：`/tmp/screen_unlock.png`
3. 发送文本：`需要我做什么其他操作吗？`

不变项：

- 接收消息逻辑不变
- 飞书 `sendImage()` 的上传与发送逻辑不变
- `send_image` 工具不变

风险点：

1. 文本中可能混用多张图片，需要保证顺序正确
2. 图片标记中的路径可能不存在，需要定义失败行为
3. 非飞书或不支持 `sendImage` 的 channel 需要有安全退化策略
4. 需要避免把空白段落拆成大量空文本消息

## 实现方案

### 1. 在 `ChannelManager.send()` 层做统一解析

选择 `src/channels/manager.ts` 作为实现位置，原因是：

1. Agent 正常回复和 `send_message` 工具都会走这里
2. 不需要修改 Provider、Tool 或 FeishuChannel 的上层调用方式
3. 可以在拿到具体 channel 实例后，根据 `sendImage` 能力决定是否发图

当前逻辑：

```ts
async send(chatJid: string, text: string) {
  const channel = this.getChannelForChat(chatJid);
  if (channel) {
    await channel.sendMessage(chatJid, text);
  }
}
```

计划改为：

1. 先解析消息内容，拆成有序片段数组
2. 片段类型分为：
   - `text`
   - `image`
3. 顺序遍历片段：
   - `text` 片段：非空时调用 `channel.sendMessage`
   - `image` 片段：若 channel 支持 `sendImage`，调用 `channel.sendImage`

### 2. 支持的图片标记

计划支持两类：

1. 自定义标签：

```text
[IMAGE:/tmp/screen_unlock.png]
```

2. 标准 Markdown 图片：

```markdown
![screen](/tmp/screen_unlock.png)
```

解析规则：

- 只提取本地文件路径
- `alt` 文本不发送到飞书
- 图片标记前后的普通文本保留并继续发送

### 3. 发送失败和降级策略

为了避免整个回复因为一张图片失败而中断，建议如下：

1. 文本片段正常发送
2. 图片片段发送失败时：
   - 记录错误日志
   - 向群里发送一条文本提示，例如：`图片发送失败: /tmp/screen_unlock.png`
3. 若当前 channel 不支持 `sendImage`：
   - 回退为发送原始文本，避免图片信息被静默吃掉

这里的“回退为原始文本”是为了保证非飞书 channel 不发生行为丢失。

### 4. helper 设计

建议新增纯函数，例如：

- `parseOutgoingMessageParts(text)`

返回结构示例：

```ts
[
  { type: "text", value: "当前画面：" },
  { type: "image", value: "/tmp/screen_unlock.png" },
  { type: "text", value: "需要我做什么其他操作吗？" },
]
```

这样可以：

1. 独立测试解析逻辑
2. 保持 `ChannelManager.send()` 主流程清晰
3. 后续如果还要支持更多富消息语法，扩展成本更低

### 5. 测试方案

建议新增 `tests/channel-manager.test.ts`，覆盖：

1. 纯文本消息只调用一次 `sendMessage`
2. 含 `[IMAGE:...]` 的消息会按顺序调用文本、图片、文本
3. 含 `![alt](path)` 的消息会调用 `sendImage`
4. 多张图片会按顺序发送
5. channel 不支持 `sendImage` 时，回退发送原始文本
6. 图片发送失败时，后续提示文本会被发送

## Todo List

- [x] 设计并实现发送阶段的图片标记解析 helper
- [x] 在 `src/channels/manager.ts` 中接入“文本/图片分片发送”逻辑
- [x] 兼容 `[IMAGE:...]` 与 Markdown 图片 `![alt](path)` 两种格式
- [x] 为不支持图片发送的 channel 增加安全降级
- [x] 新增或更新测试覆盖纯文本、单图、多图、失败降级场景
- [x] 运行相关测试并确认通过
