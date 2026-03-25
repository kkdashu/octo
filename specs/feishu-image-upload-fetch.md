# 飞书图片上传改为 fetch + FormData

## 问题说明

当前项目已经支持在发送阶段把消息拆分成文本和图片，并在遇到图片片段时调用：

- `src/channels/feishu.ts` 中的 `sendImage(chatId, filePath)`

但实际发送时，文本可以成功发出，图片上传会失败。日志显示：

- `Failed to send image to chat ...`
- `AxiosError: Request failed with status code 400`

说明失败点发生在飞书图片上传接口调用阶段，而不是消息拆分、路径解析或文本发送阶段。

当前实现使用的是：

- `@larksuiteoapi/node-sdk`
- `createReadStream(filePath)`
- `this.client.im.image.create(...)`

结合现象和参考实现，可以判断当前问题大概率出在 Bun 环境下 `node-sdk/axios + stream` 的图片上传链路不稳定或不兼容。

本次修复目标：

1. 保留现有消息拆分逻辑
2. 保留后续“发送 image message”的逻辑
3. 只替换图片上传步骤
4. 将图片上传改为：
   - 使用 `fetch` 获取 `tenant_access_token`
   - 使用 `fetch + FormData + Blob` 上传图片到飞书

## 对现有项目的影响

受影响文件：

- `src/channels/feishu.ts`
- `tests` 下可能新增或补充与图片上传 helper 相关的测试

行为变化：

1. `sendImage()` 不再走 `this.client.im.image.create(...)`
2. 改为手动调用飞书开放平台 REST 接口上传图片
3. 上传成功后，仍使用现有 SDK 的 `im.message.create(...)` 发送图片消息

不变项：

- `ChannelManager.send()` 的文本/图片分片逻辑不变
- `sendMessage()` 文本消息发送逻辑不变
- 图片消息的最终发送接口仍保持现有实现
- 接收消息逻辑不变

风险点：

1. 需要正确处理 token 获取失败
2. 需要正确构造 multipart/form-data
3. 上传接口返回非 0 code 时要保留足够的错误信息，便于排查
4. 文件 MIME type 可能未知，至少要保证 PNG/JPG 截图上传正常

## 实现方案

### 1. 在 `src/channels/feishu.ts` 中新增上传 helper

建议新增两个小 helper：

- `getTenantAccessToken()`
- `uploadImageWithFetch(filePath)`

职责：

1. `getTenantAccessToken()`
   - POST `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
   - body 使用当前 appId / appSecret
   - 返回 `tenant_access_token`

2. `uploadImageWithFetch(filePath)`
   - 读取图片文件内容
   - 构造 `FormData`
   - `image_type=message`
   - `image` 字段使用 `Blob`
   - POST `https://open.feishu.cn/open-apis/im/v1/images`
   - 从响应中提取 `image_key`

### 2. 改造 `sendImage()`

当前流程：

1. 校验文件大小
2. `this.client.im.image.create(...)`
3. 用返回的 `image_key` 调用 `this.client.im.message.create(...)`

改造后流程：

1. 校验文件大小
2. 调用 `uploadImageWithFetch(filePath)` 得到 `image_key`
3. 保持原有 `this.client.im.message.create(...)` 发图片消息逻辑不变

这样可以把风险收敛到“上传步骤”这一处。

### 3. 错误处理

需要增强错误信息，至少包含：

- token 接口的 `code`
- 图片上传接口的 `code`
- 若返回了 `msg` 或原始 body，也要尽量记录

目标是避免只有一个 `AxiosError 400`，而看不到飞书业务错误码。

### 4. 测试方案

由于这里涉及网络接口，建议优先把上传逻辑拆成纯 helper，并通过 mock `fetch` 做单元测试，覆盖：

1. token 获取成功
2. token 获取失败
3. 图片上传成功返回 `image_key`
4. 图片上传失败返回明确错误

如果当前仓库测试体系下不方便完整 mock，也至少保证：

1. 相关 helper 可独立调用
2. 失败时报错信息比现在更可诊断

## Todo List

- [x] 在 `src/channels/feishu.ts` 中新增基于 `fetch` 的 token 获取 helper
- [x] 在 `src/channels/feishu.ts` 中新增基于 `fetch + FormData` 的图片上传 helper
- [x] 将 `sendImage()` 的上传步骤替换为新 helper
- [x] 保持图片消息最终发送逻辑不变
- [x] 增加或更新测试，覆盖上传成功/失败路径
- [x] 运行相关测试并确认通过
