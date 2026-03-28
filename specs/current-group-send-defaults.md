# 当前群消息/图片发送默认目标修复

## 问题描述

当前 Octo 的 `send_message` 和 `send_image` 工具都要求 Agent 显式传入 `chatJid`。  
这在“跨群发送”场景下是合理的，但在“给当前对话所在群回复”这个最常见场景下，会带来两个问题：

1. Agent 并不总是知道当前群真正的 chat ID
2. Agent 很容易把“用户 ID”误当成“群 ID”传给工具

本次线上日志已经出现了明确案例：

- 当前群实际 chat ID：`oc_127c0a0fa082cd14b8c2f289d9d012f5`
- Agent 调用 `send_image` 时传入的是：`ou_9a29ef19141dbc13dee9090c73078ce8`

其中：

- `oc_...` 是飞书群聊 chat ID
- `ou_...` 是飞书用户 ID

最终链路是：

```text
generate_image
  → send_image(chatJid = ou_...)
  → Feishu sendImage(chatId = ou_...)
  → 400 Bad Request
```

所以这次失败的根因不是：

- 图片没有生成
- 文件路径不对
- 飞书图片上传逻辑损坏

而是 **Agent 在“回复当前群”时缺少稳定的默认目标 chat ID 机制**。

### 额外发现

排查过程中还发现提示模板存在不一致：

- `groups/main/CLAUDE.md` 当前没有列出 `send_image` / `generate_image`
- `groups/GROUP_CLAUDE.md` 虽然列了 `send_image`，但没有说明“给当前群回复时可以省略 chatJid”

这会进一步增加 Agent 误用工具参数的概率。

## 对现有项目的影响

### 需要修改的文件

- `src/tools.ts`
- `groups/MAIN_CLAUDE.md`
- `groups/GROUP_CLAUDE.md`
- `groups/main/CLAUDE.md`
- `tests/providers.test.ts`

### 预计不需要修改的文件

- `src/channels/manager.ts`
- `src/channels/feishu.ts`
- `src/group-queue.ts`
- `src/runtime/minimax-image.ts`

原因：

1. 真实失败发生在工具参数层，而不是通道发送层
2. 飞书发送图片链路已经拿到了正确的本地文件路径
3. 只要工具层把默认目标解析成当前群 `group.jid`，现有 `sendImage()` 链路就可以复用

### 风险与兼容性

#### 1. 不能破坏主群跨群发送能力

主群当前具备“向任意群发送消息/图片”的管理能力。  
修复后必须仍然支持：

- 显式传 `chatJid` → 发到指定群
- 省略 `chatJid` → 默认发到当前群

不能为了修复当前群回复而把主群的跨群能力做没。

#### 2. 普通群仍要保留权限限制

普通群目前不允许向其他群发送消息/图片。  
修复后应保持：

- 普通群省略 `chatJid` → 自动发回当前群
- 普通群显式传其它群 jid → 仍然拒绝

#### 3. 需要兼容已有 Agent 行为

当前 Agent 可能已经会显式传 `chatJid`。  
因此本次应把 `chatJid` 从“必填”改成“可选但推荐”，而不是删除该字段。

## 实施方案

### 一、核心修复策略

在 `src/tools.ts` 中为 `send_message` 和 `send_image` 增加“当前群默认目标”解析逻辑：

```ts
function resolveTargetChatJid(
  db: Database,
  groupFolder: string,
  requestedChatJid: unknown,
): { ok: true; chatJid: string } | { ok: false; message: string }
```

规则如下：

1. 若当前 `groupFolder` 查不到注册群信息，返回错误
2. 若 `chatJid` 未提供或为空字符串，则默认使用当前群的 `group.jid`
3. 若当前不是主群，且显式传入的 `chatJid !== group.jid`，则拒绝
4. 若当前是主群，允许显式传其它群 jid

这意味着：

```text
主群：
- send_image(filePath=...)                → 发回主群当前 chat
- send_image(chatJid="oc_xxx", filePath=...) → 发到指定群

普通群：
- send_image(filePath=...)                → 发回当前群
- send_image(chatJid="其它群", filePath=...) → 拒绝
```

### 二、工具 schema 调整

#### `send_message`

当前 schema：

```ts
required: ["chatJid", "text"]
```

修复后改为：

```ts
required: ["text"]
```

并把字段说明改成：

```ts
chatJid: {
  type: "string",
  description: "Optional target chat ID. Omit it to send back to the current group."
}
```

#### `send_image`

当前 schema：

```ts
required: ["chatJid", "filePath"]
```

修复后改为：

```ts
required: ["filePath"]
```

并把字段说明改成：

```ts
chatJid: {
  type: "string",
  description: "Optional target chat ID. Omit it to send back to the current group."
}
```

这样 Agent 在“回复当前群”时根本不需要知道 `oc_...`。

### 三、工具处理逻辑调整

在两个 handler 中统一使用解析结果：

```ts
const target = resolveTargetChatJid(db, groupFolder, args.chatJid);
if (!target.ok) {
  return { content: [{ type: "text", text: target.message }] };
}

await sender.send(target.chatJid, text);
await sender.sendImage(target.chatJid, filePath);
```

同时日志里应记录：

- 原始 `args.chatJid`
- 解析后的 `target.chatJid`

便于之后再遇到类似误传 `ou_...` 时快速定位。

### 四、提示模板同步

需要更新以下提示文件：

- `groups/MAIN_CLAUDE.md`
- `groups/GROUP_CLAUDE.md`
- `groups/main/CLAUDE.md`

更新内容：

1. 明确列出 `send_image`
2. 在可用工具里加入 `generate_image`
3. 明确说明：

```text
When replying to the current group, omit chatJid.
Only provide chatJid when you intentionally want to send to another group.
```

这样做的原因：

- schema 改完后，Agent 仍然需要被明确引导使用“省略 chatJid”的模式
- 主群现有提示文件缺少图片相关工具说明，本身就容易误导模型

### 五、测试方案

更新 `tests/providers.test.ts` 或新增独立工具测试，至少覆盖：

1. `createGroupToolDefs()` 中 `send_message` / `send_image` 的 schema 不再要求 `chatJid`
2. 普通群省略 `chatJid` 时，发送目标自动回落到当前群 `jid`
3. 普通群显式传其它群 jid 时仍返回权限错误
4. 主群省略 `chatJid` 时，默认发到主群 `jid`
5. 主群显式传其它群 jid 时仍允许发送

如果测试直接触发 handler，建议使用 stub sender 收集最终发送目标，断言是否是：

- 当前群 `oc_...`
- 或显式指定的目标群

### 六、为什么不在通道层自动纠正 `ou_...`

看起来也可以在 `ChannelManager` 或 `FeishuChannel` 层对 `ou_...` 做兜底，但这不是合适的边界：

1. 通道层并不知道 Agent 本来“想发给谁”
2. 把用户 ID 自动改成当前群 ID 会掩盖调用方错误
3. 同类问题在 `send_message` 上也一样存在，真正的问题在工具契约设计而不是通道层

所以正确修复点应该是工具层默认值和提示模板，而不是下游偷偷纠正。

## Todo List

- [x] 新增 `specs/current-group-send-defaults.md` 并完成评审
- [x] 修改 `src/tools.ts`，让 `send_message` / `send_image` 的 `chatJid` 变为可选
- [x] 在 `src/tools.ts` 中新增当前群默认目标解析逻辑
- [x] 更新 `groups/MAIN_CLAUDE.md`，补齐 `send_image` / `generate_image` 和 chatJid 使用说明
- [x] 更新 `groups/GROUP_CLAUDE.md`，补充“回复当前群时省略 chatJid”的说明
- [x] 更新 `groups/main/CLAUDE.md`，让当前主群 prompt 立即生效
- [x] 更新测试，覆盖主群/普通群的默认发送目标与权限行为
- [x] 运行相关测试并确认全部通过
