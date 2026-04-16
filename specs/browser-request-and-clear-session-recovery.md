# 浏览请求误答与 `/clear` 清理失败修复

## 问题描述

本次现象包含两类问题，而且它们连续出现后会把主群会话带进一个很差的状态：

1. 用户明确要求“使用 `octo-browser` skill 打开小红书网站”，系统没有进入本地 Chrome 浏览流程，反而输出了关于 `ou_...` / `oc_...` JID 的解释性文本。
2. 用户随后多次发送 `/clear`，系统回复“Session 清理失败，请稍后重试。”，导致错误上下文无法快速恢复。

从当前代码和提示词可以确认：

- `ou_...` 是飞书用户 ID，`oc_...` 是飞书群聊 chat ID。
- 当前代码里并不存在会主动生成
  “The JID ... doesn't match any registered group”
  这类固定文案的系统逻辑，因此这段内容更像是模型在错误上下文里自行编造的回复。
- `/clear` 由 `src/router.ts` 直接拦截并调用 `groupQueue.clearSession()`；用户看到的失败文案，说明异常是在清理链路内部抛出的，而不是模型回复。

结合现有实现，最可能的故障链路是：

1. 浏览请求没有被明确引导到 `octo-browser` 工作流，模型转而尝试从 chat/JID 角度解释请求。
2. 群里已有一个持久化 session id。
3. `/clear` 时 `GroupQueue` 会优先尝试以该旧 session id 执行 Claude SDK 的 resumed `/clear`。
4. 如果该 session 在本地列表里仍可见，但实际上已不可恢复、已损坏、或 SDK 在 resumed `/clear` 时返回异常，当前实现不会降级重试 fresh clear，而是直接抛错。
5. Router 捕获错误后向用户发送“Session 清理失败，请稍后重试。”，造成会话无法自救。

因此本次修复目标不是“让模型更会聊天”，而是：

- 把浏览类请求更稳定地导向 `octo-browser` / `agent-browser` 工作流
- 让 `/clear` 在旧 session 不可恢复时仍然能够成功清理
- 避免把用户卡死在无法清理的错误会话里

## 对现有项目的影响

### 需要修改的文件

- `src/providers/claude.ts`
- `src/group-queue.ts`
- `groups/main/CLAUDE.md`
- `tests/providers.test.ts`
- `tests/router.test.ts`

### 可能不需要修改的文件

- `src/channels/manager.ts`
- `src/channels/feishu.ts`
- `src/tools.ts`

原因：

1. `ou_` / `oc_` 本身不是这次 `/clear` 失败的根因。
2. 当前 `send_message` / `send_image` 的“省略 `chatJid` 默认回复当前群”逻辑已经存在。
3. `/clear` 失败点更接近 provider resume 与 session 恢复策略，而不是通道发送。

## 实施方案

### 一、补齐主群提示：浏览请求必须优先走 `octo-browser`

当前 `groups/main/CLAUDE.md` 虽然写了可以用 `agent-browser` 浏览网页，但没有把“用户明确点名 `octo-browser skill`”这个场景收敛成强规则。

本次调整：

1. 在主群提示中明确增加一条规则：
   - 当用户明确说“使用 `octo-browser skill`”“打开网页”“浏览网页”“打开某网站”时，优先进入本地 Chrome + `agent-browser` 流程。
2. 明确禁止把浏览请求误解释成 chat/JID 注册校验问题，除非用户明确在问聊天目标或群注册问题。
3. 明确浏览失败时应直接报告浏览器/CDP/页面层面的错误，不要生成与当前请求无关的群聊 ID 解释。

这一步的目标不是完全防止模型跑偏，而是降低再次产生“JID 不匹配”这类离题回复的概率。

### 二、把 `/clear` 实现改成“两段式恢复”

当前 `GroupQueue.clearSession()` 会先解析 `resumeSessionId`，然后直接调用：

```ts
provider.clearContext({ resumeSessionId })
```

问题在于：

- `resolveClaudeResumeSessionId()` 只检查 session 是否仍出现在本地 `listSessions()` 结果里。
- “本地可见”不等于“Claude SDK 一定还能成功 resume 并执行 `/clear`”。
- 一旦 resumed clear 抛错，当前实现直接失败，没有任何恢复路径。

本次改为两段式策略：

#### 第一阶段：优先尝试 resumed `/clear`

保持现有行为：

- 若存在可恢复的 `resumeSessionId`，先尝试基于旧 session 执行 `/clear`

#### 第二阶段：失败后自动降级为 fresh `/clear`

如果 resumed `/clear` 抛错，则：

1. 记录降级日志，带上：
   - `groupFolder`
   - `previousSessionId`
   - `resumeSessionId`
   - 错误消息
2. 清除数据库里的旧 session id
3. 以 `resumeSessionId = undefined` 再调用一次 `provider.clearContext()`
4. 如果 fresh clear 成功，则将新 session id 持久化，并把这次 `/clear` 视为成功
5. 只有 fresh clear 也失败时，才真正向上抛错

这样做的意义：

- 用户的诉求是“把当前 AI 会话清掉”，并不要求一定从旧 session 上执行 slash command。
- 只要 fresh clear 能拿到新的空白 session，产品语义上就算成功恢复。

### 三、在 Provider 层增加明确的降级边界

为了避免降级逻辑散落在 Router，建议把恢复职责放在 session 管理边界，而不是消息路由边界。

具体做法：

1. `src/group-queue.ts` 负责：
   - 判断是否有旧 session
   - 先调用 resumed clear
   - 失败后删除旧 session id 并 retry fresh clear
2. `src/providers/claude.ts` 继续只负责单次 clear 执行
   - 输入什么 `resumeSessionId`
   - 输出是否拿到有效新 session id
   - 不在 provider 内部悄悄做多次重试

这样边界更清楚：

- provider 负责“执行一次 clear”
- group queue 负责“决定用哪种 clear 策略恢复用户会话”

### 四、保留现有 fresh-session 判定约束

`src/providers/claude.ts` 里的 `resolveClearedSessionId()` 目前有一个很重要的安全约束：

- 若本次 clear 是在旧 session 基础上 resume 的，则必须拿到不同于旧 session 的新 session id

这个约束仍然应保留，不能放宽。

原因：

1. 如果 resumed `/clear` 返回的还是旧 session id，那么从产品语义上讲并没有清掉。
2. 当前真正缺的是失败后的恢复路径，而不是放松成功判定。

所以本次不应把“旧 id 也算成功”当成修复手段，而应采用：

- resumed clear 失败或返回无效新 id
- 直接降级到 fresh clear

### 五、Router 成功文案保持不变，失败概率显著下降

`src/router.ts` 当前的 `/clear` 用户提示语义已经是合理的：

- 成功：`Session 已清理。仅清理 AI session；group memory、待处理消息和文件不会被清理。`
- 失败：`Session 清理失败，请稍后重试。`

本次不需要改这两个文案，重点是通过恢复策略让第二种情况变成真正的罕见异常。

### 六、测试方案

至少补充以下测试：

#### 1. `GroupQueue` / clear 恢复策略

建议在 `tests/router.test.ts` 或新增更贴近 `group-queue` 的测试中覆盖：

- 当首次 `clearSession()` 内部 resumed clear 抛错，但 fresh clear 成功时：
  - Router 仍发送成功文案
  - 不发送“Session 清理失败，请稍后重试。”

若当前直接构造 `GroupQueue` 成本较高，也可以通过 mock `groupQueue.clearSession()` 的上层行为验证 Router 分支，但更推荐补一个更靠近 `group-queue` 的单元测试。

#### 2. Provider clear session id 判定

在 `tests/providers.test.ts` 中新增：

- resumed clear 抛错时，上层可以据此触发降级
- fresh clear 只要返回新的 `init.session_id` 或 `result.session_id`，即可被接受
- 保持“resumed clear 返回旧 session id 时仍判定失败”

#### 3. 主群提示词规则

这类内容通常不做程序测试，但需要在 spec 中明确修改 `groups/main/CLAUDE.md`，避免后续再次遗漏。

## 兼容性与风险

### 1. 风险：误把真实严重错误当成可恢复问题

降级 retry 不能吞掉所有错误后默默成功。

要求：

- 只有第一次 resumed clear 失败时才进入一次 fresh retry
- fresh retry 若失败，必须继续抛错
- 日志中要保留第一次失败原因与第二次尝试结果

### 2. 风险：旧 session id 被错误保留

如果 resumed clear 失败后不及时删除旧 session id，后续仍可能不断重试同一个坏 session。

要求：

- 在 fresh retry 前先 `deleteSessionId()`
- fresh clear 成功后再 `saveSessionId()`

### 3. 风险：误以为这次修复能“保证模型绝不跑偏”

提示词收敛只能降低浏览请求误答概率，不能从根本上保证模型永不离题。

本次真正强保证的是：

- 即使模型前一轮已经跑偏，用户仍然能通过 `/clear` 把会话救回来

## Todo List

- [ ] 新增 `specs/browser-request-and-clear-session-recovery.md` 并完成评审
- [ ] 更新 `groups/main/CLAUDE.md`，明确浏览请求优先走 `octo-browser` / `agent-browser` 工作流
- [ ] 修改 `src/group-queue.ts`，给 `/clear` 增加 resumed clear 失败后的 fresh clear 降级重试
- [ ] 保持 `src/providers/claude.ts` 对 fresh session id 的严格判定，不放宽 resumed clear 的成功条件
- [ ] 更新测试，覆盖 resumed clear 失败但 fresh clear 成功的恢复路径
- [ ] 运行相关测试并确认通过
