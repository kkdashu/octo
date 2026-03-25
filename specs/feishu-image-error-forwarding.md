# 飞书图片权限错误透传给群消息

## 问题说明

当前系统在发送带图片的回复时，会把消息拆成文本片段和图片片段顺序发送。

当图片发送失败时，`src/channels/manager.ts` 当前会统一回退为一条泛化提示：

```text
图片发送失败: /tmp/xxx.png
```

这在一般失败场景下可以接受，但对于飞书权限类错误，日志里已经包含了明确且可操作的信息，例如：

```text
Failed to upload image: code=99991672, msg=Access denied. One of the following scopes is required: [im:resource:upload, im:resource]...
```

这种情况下只把文件路径发给群用户，信息不足，用户看不到真正原因，也无法知道需要去开通权限。

本次修复目标：

1. 保持图片发送主流程不变
2. 保持普通失败时仍有兜底提示
3. 当错误对象里已经有明确错误消息时，把该消息发回群里
4. 尤其是飞书权限类错误，要让用户直接在群里看到具体报错

## 对现有项目的影响

受影响文件：

- `src/channels/manager.ts`
- `tests/channel-manager.test.ts`

行为变化：

1. 图片发送成功时行为不变
2. 图片发送失败时，不再固定发送 `图片发送失败: <path>`
3. 若 `err` 是 `Error` 且有非空 `message`，则发送：
   - `图片发送失败: <error.message>`
4. 若拿不到明确错误信息，再退回原来的文件路径提示

不变项：

- `src/channels/feishu.ts` 上传逻辑不变
- 文本/图片分片逻辑不变
- 不新增新的权限判断逻辑，只透传已有错误

风险点：

1. 某些错误消息可能很长，群里可读性一般
2. 某些错误消息可能包含路径或内部实现细节

本次先优先保证可诊断性，不做额外截断或脱敏。

## 实现方案

### 1. 调整 `ChannelManager.send()` 中的失败回退文案

当前逻辑大致是：

```ts
catch (err) {
  log.error(...)
  await channel.sendMessage(chatJid, `图片发送失败: ${part.value}`);
}
```

计划改为：

1. 先提取错误消息：
   - `err instanceof Error ? err.message : ""`
2. 若错误消息存在且非空：
   - 发送 `图片发送失败: ${err.message}`
3. 否则：
   - 发送 `图片发送失败: ${part.value}`

### 2. 测试覆盖

在 `tests/channel-manager.test.ts` 中补充或调整：

1. 图片发送失败且错误对象有 message 时，应发送该 message
2. 图片发送失败但没有可用 message 时，仍回退为路径提示

## Todo List

- [x] 修改 `src/channels/manager.ts` 的图片发送失败回退逻辑
- [x] 优先透传 `Error.message`
- [x] 保留路径提示作为兜底
- [x] 更新测试覆盖权限错误透传场景
- [x] 运行相关测试并确认通过
