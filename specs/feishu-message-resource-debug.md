# 飞书消息资源下载错误诊断增强

## 问题说明

当前飞书接收图片链路已经会调用消息资源接口下载图片：

- `src/channels/feishu.ts`
  - `downloadIncomingImageResource()` 调用 `client.im.messageResource.get(...)`
  - `extractImageContent()` / `extractPostContent()` 在失败时只记录：
    - `error: err.message`
    - `messageId`
    - `chatId`
    - `imageKey`

现状日志的问题是：

1. 当飞书 SDK 抛出 `Request failed with status code 400` 时，日志里没有业务错误码，也没有响应体。
2. 由于缺少飞书返回的 `code` / `msg`，当前无法判断失败究竟是：
   - `234001` 请求参数错误
   - `234003` 资源不属于该消息
   - `234004` 应用不在会话中
   - `234009` 外部群不支持
   - `234040` 消息对操作者不可见
   - `234043` 不支持的消息类型
   - 或其他文档列出的业务错误
3. 现有日志无法验证请求是否满足 `docs/feishu/get_message_resource.md` 中的关键约束：
   - `message_id` 与 `file_key` 必须匹配
   - `type=image` 仅适用于图片或富文本消息中的图片
   - 机器人必须与目标消息在同一会话内
   - 调用方需要具备 `im:message` / `im:message:readonly` / `im:message.history:readonly` 之一

本次需求目标不是直接猜测根因，而是先把诊断能力补齐，让下一次失败日志能直接回答“飞书到底返回了什么错误”。

本次目标：

1. 在 `messageResource.get` 失败时打印完整而可读的错误详情
2. 日志中明确区分 HTTP 状态码、飞书业务错误码、飞书业务错误消息
3. 按 `docs/feishu/get_message_resource.md` 给出面向排查的诊断提示
4. 保持当前消息处理与兜底行为不变，下载失败时仍回退为 `[图片下载失败:...]`

## 对现有项目的影响

受影响文件预计包括：

- `src/channels/feishu.ts`
- `tests/feishu.test.ts`
- 如有必要，补充一个专门的错误格式化 helper 测试文件

行为影响：

1. 图片下载成功时行为不变。
2. 图片下载失败时，消息入库与回退文本行为不变。
3. 新增更详细的错误日志，至少包含：
   - HTTP 状态码
   - HTTP 状态文本
   - 飞书响应体 `code`
   - 飞书响应体 `msg`
   - 本次请求携带的 `message_id`
   - 本次请求携带的 `file_key`
   - 本次请求携带的 `type`
4. 日志中会附带基于文档的诊断提示，帮助快速判断更可能是参数、会话、权限还是消息类型问题。

明确不做的事：

- 不改变图片下载的 API 路径
- 不改变当前 Markdown 图片落库规则
- 不修改数据库结构
- 不在本次直接改成其他飞书 API
- 不因为诊断增强而吞掉原始错误

风险点：

1. 飞书 SDK 抛出的错误对象结构不稳定，不能假设一定是标准 `AxiosError` 类型。
2. 直接把整个响应对象写日志可能过大，需要做裁剪。
3. 如果日志结构设计过散，后续查看仍不方便，需要统一格式。

## 实现方案

### 1. 为消息资源下载增加统一的错误提取 helper

在 `src/channels/feishu.ts` 中新增一个专门用于解析下载错误的 helper，例如：

```ts
type FeishuMessageResourceErrorDetails = {
  message: string;
  httpStatus: number | null;
  httpStatusText: string | null;
  feishuCode: number | null;
  feishuMsg: string | null;
  responseDataPreview: string | null;
  requestSummary: {
    messageId: string;
    fileKey: string;
    type: "image";
  };
  diagnosisHints: string[];
};

function extractMessageResourceErrorDetails(
  err: unknown,
  requestSummary: {
    messageId: string;
    fileKey: string;
    type: "image";
  },
): FeishuMessageResourceErrorDetails
```

设计原则：

1. 不强依赖 `AxiosError` 类型导入，改用对 `unknown` 的结构化收窄。
2. 优先从 `err.response.data` 中读取飞书业务错误体。
3. 若响应体不是对象，则保留一个裁剪后的字符串预览。
4. 若读取不到业务错误码，也至少保留原始 `err.message`。

### 2. 在下载 helper 处记录请求摘要

当前 `downloadIncomingImageResource()` 只有下载逻辑，没有对请求参数做结构化记录。

计划在该函数中把这三项明确带入错误处理：

- `messageId`
- `imageKey`（实际传给接口的 `file_key`）
- `type: "image"`

这样日志可以直接对应文档：

- `message_id`
- `file_key`
- `type`

从而验证是否满足 `docs/feishu/get_message_resource.md` 的参数要求。

### 3. 按文档映射出针对性的诊断提示

参考 `docs/feishu/get_message_resource.md`，在 helper 内对常见错误码给出固定提示：

- `234001`
  - 请求参数无效，优先检查 `message_id` / `file_key` / `type`
- `234003`
  - 资源不属于当前消息，重点检查 `message_id` 和 `image_key` 是否匹配
- `234004`
  - 应用不在消息所在会话中，重点检查是否为错误消息 ID 或机器人不在目标群
- `234009`
  - 外部群不支持本操作
- `234019`
  - 应用权限信息未获取到，可重试并检查应用权限状态
- `234040`
  - 消息对操作者不可见，重点检查会话历史可见性
- `234043`
  - 不支持的消息类型，重点检查是否为卡片消息或合并转发子消息

对于没有收敛到固定错误码的场景，保留通用提示：

- 核对机器人能力是否开启
- 核对机器人与消息是否位于同一会话
- 核对应用是否具备 `im:message` / `im:message:readonly` / `im:message.history:readonly`

### 4. 在两个调用点使用统一日志结构

当前有两个下载失败入口：

1. `extractPostContent()`
2. `extractImageContent()`

计划统一改为：

1. 捕获异常
2. 调用 `extractMessageResourceErrorDetails(...)`
3. 用统一结构 `log.error(...)`
4. 继续返回 `[图片下载失败:image_key=...]`

这样可以保证：

- `post` 富文本图片与独立 `image` 消息的日志字段一致
- 后续排查时不需要分别阅读两套格式

### 5. 测试覆盖

计划补充以下测试：

1. 当下载接口抛出带 `response.status` 与 `response.data` 的错误对象时：
   - 能提取 HTTP 状态码
   - 能提取飞书业务错误码与消息
   - 能输出与请求参数对应的摘要
2. 当错误对象只有 `message` 时：
   - 仍能保留基础错误信息
   - 不会因为缺失 `response` 而崩溃
3. 对文档中关键错误码至少覆盖一个映射用例，例如：
   - `234003`
   - `234043`

### 6. 实施后的排查方式

代码改完后，下一次实际失败日志应能直接回答如下问题：

1. HTTP 层是否成功到达飞书
2. 飞书业务错误码是什么
3. 是参数不匹配、消息不可见、消息类型不支持，还是会话/权限问题

如果真实日志显示是：

- `234003`
  - 说明当前传入的 `message_id` 和 `image_key` 并不匹配，需要继续排查事件体或消息内容解析
- `234043`
  - 说明当前消息并非普通图片消息或富文本图片，而是文档中不支持的消息类型
- `234004` / `234040`
  - 说明问题更偏向会话可见性而不是代码参数格式
- `234019` 或权限相关提示
  - 说明需要回到飞书应用权限配置继续确认

## Todo List

- [x] 在 `src/channels/feishu.ts` 中新增消息资源下载错误详情提取 helper
- [x] 在 `downloadIncomingImageResource()` 的失败路径中附带请求摘要
- [x] 在 `extractPostContent()` / `extractImageContent()` 中统一输出结构化错误日志
- [x] 按 `docs/feishu/get_message_resource.md` 增加错误码到诊断提示的映射
- [x] 更新测试，覆盖带响应体的下载错误解析
- [x] 更新测试，覆盖只有基础 message 的兜底解析
- [x] 运行相关测试并确认通过
- [ ] 基于新日志再次核对真实错误码，再决定是否需要进一步改请求逻辑
