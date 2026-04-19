# Feishu Streaming Prompt 竞态修复方案

## 问题描述

当前 `FeishuGroupAdapter` 在处理飞书群消息时，存在一个会话状态机竞态：

1. 群里已有一个活跃的 Pi session，且 session 仍处于 streaming / auto-retry / auto-compaction 链路中。
2. 初始消息在进入 Pi session 之前，需要先经过 `preparePrompt()`，而这里可能包含较慢的图片预处理。
3. 在这段“初始 prompt 还未真正发出”的窗口里，router 已经把当前 group 视为 active，因此新消息会调用 `groupQueue.pushMessage(..., { mode: "follow_up" })`。
4. 由于 adapter 之前没有区分“session 已创建”和“初始 prompt 已发出”，follow-up 会被直接送进该 session。
5. 此时底层 session 尚未进入 streaming，follow-up 会错误走到 `prompt()` 分支，抢先成为第一个 prompt。
6. 等原始初始 prompt 的预处理结束后，再尝试发送自己的 `mode="prompt"` 时，底层 session 已经在 streaming，于是抛出：

```text
Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.
```

用户侧表现为：

1. 飞书里收到一条 `AI 运行失败...` 的错误消息
2. 本应继续 follow-up 的同一轮会话被错误中断

从日志可以确认该问题已经真实发生：

1. router 先记录 `Pushing follow-up to active session`
2. 随后 adapter 抛出 `mode=prompt while streaming`

因此这不是日志噪声，而是需要修复的状态机 bug。

## 对现有项目的影响

### 一、直接受影响模块

1. `src/runtime/feishu-group-adapter.ts`
   - `runTurn()`
   - `handleSessionEvent()`
   - `waitForOutboundDrain()`
   - `activeSessions` 生命周期管理
2. `tests/feishu-group-adapter.test.ts`
   - 需要补一个能稳定复现该竞态的测试

### 二、间接受影响的行为

1. `src/router.ts`
   - 当前逻辑 `isActive() => push follow_up` 是合理的，原则上不需要改
2. 飞书消息发送时序
   - 修复后，同 group follow-up 会更稳定地复用现有 session
3. 错误上报频率
   - 修复后应减少这类 `mode=prompt while streaming` 的用户可见失败消息

### 三、不打算修改的部分

1. `src/runtime/image-message-preprocessor.ts`
   - 图片理解超时本次不处理
2. `src/runtime/minimax-token-plan-mcp.ts`
   - `stderr` 下载日志本次不处理
3. `src/router.ts` 的 trigger 逻辑
   - 当前日志显示 router 已正确区分 active session 与 new session，不是根因

## 实现方案

### 一、根因分析

当前 `FeishuGroupAdapter` 的问题主要在于：

1. `runTurn()` 创建 session 后，会先把该 session 放进 `activeSessions`
2. 但初始 `prompt` 在真正发出前，还要经过异步 `preparePrompt()`
3. 这段时间内，`pushMessage()` 会把 follow-up 直接送进 session
4. 由于 session 还没开始 streaming，follow-up 会退化成新的 `prompt()`
5. 于是最初那条初始 `prompt` 在稍后真正准备完时，就会撞上：

```ts
if (activeSession.host.session.isStreaming) {
  throw new Error("Cannot send mode=prompt while the Pi session is streaming...");
}
```

所以根因不是单纯的“turn 清理过早”，而是：

1. 初始 prompt 发送前缺少一个“已真正发出”的门槛
2. 在该门槛之前，follow-up 不应该立刻下发，而应该先缓冲

### 二、修复方向

修复原则：

1. `activeSessions` 可以在初始 prompt 预处理阶段就存在，但此时 follow-up 不能直接发送到底层 session
2. 必须区分“session 已创建”和“初始 prompt 已经真正发出”
3. 初始 prompt 发出之前到来的 follow-up / steer，要先缓冲
4. 等初始 prompt 已经进入 session（例如已经 `prompt()` 或收到 `turn_start`）之后，再冲刷这些缓冲输入

推荐做法：

1. 在 `ActiveGroupSession` 上增加：
   - `initialInputPending`
   - `pendingInitialInputs`
   - `initialInputFlush`
2. `pushMessage()` 发现初始 prompt 还未真正发出时，不直接发送，而是先写入 `pendingInitialInputs`
3. 初始 prompt 真正发出后：
   - 如果 `session.isStreaming === true`，立即释放缓冲队列
   - 或在收到 `turn_start` 时释放缓冲队列
4. 若初始 prompt 已经完成但仍未释放缓冲，也要在 `runTurn()` 继续往下执行前同步冲刷一次，避免消息遗失

这样可以保证：

1. 慢初始 prompt 不会被后来的 follow-up 抢跑
2. follow-up 在 session 真正 ready 之后仍会进入同一条会话
3. 不再出现“原始 prompt 晚到，结果撞上 streaming guard”的用户可见报错

### 三、缓冲队列的释放条件

这里需要定义“什么时候可以安全地把缓冲 follow-up 发出去”。

建议使用以下条件：

1. 首选 `turn_start`
   - 说明初始 prompt 已真正进入 runtime
   - 此时 follow-up 再发送，能正确走 `followUp()` 分支
2. 次选 `session.isStreaming === true`
   - 在调用初始 `prompt()` 后立即检查
   - 如果底层已同步切到 streaming，可提前释放缓冲队列
3. 兜底为“初始 prompt 已返回”
   - 如果极端情况下没有观测到 `turn_start`，也不能让缓冲输入永久挂起
   - 此时允许在 `runTurn()` 继续结束前同步冲刷一次

### 四、并发与清理细节

修复时要注意以下细节：

1. `pushMessage()` 可能在 `runTurn()` 初始 prompt 预处理阶段进入
   - 这是本次要修复的核心路径
   - 此时应该缓冲，不应该直接发送
2. `clearSession()` 仍然要能中断当前 active session
   - 需要把 session 标记为 closed，避免缓冲队列在 session 已关闭后继续冲刷
3. `reportRuntimeFailure()` 不能因为缓冲冲刷失败而重复发送错误
   - 错误去重逻辑继续保留
4. sessionRef 保存时机
   - 保持在当前 turn 结束后保存即可，本次不调整其归属

### 五、测试方案

需要在 `tests/feishu-group-adapter.test.ts` 新增一个能稳定复现当前日志问题的测试。

测试思路：

1. 构造一个 fake session host
2. 让初始消息的 `preparePrompt()` 人为变慢
3. 在这段时间里 push 一个 `follow_up`
4. 断言：
   - 初始 prompt 发出前，底层 session 还没有收到任何调用
   - 初始 prompt 准备完成后，第一条调用必须是原始 `prompt`
   - 后续消息必须以 `follow_up` 形式进入，而不是抢跑成新的 `prompt`
5. 断言：
   - 不会抛出 `Cannot send mode=prompt while the Pi session is streaming`
   - follow-up 仍走现有 session
   - 用户不会收到额外的 `AI 运行失败` 消息

如有必要，可以同步增强现有 fake host：

1. 发出 `turn_start`
2. 在释放时发出 `turn_end`
3. 让测试更贴近真实日志序列

## Todo List

- [x] 深入梳理 `FeishuGroupAdapter` 当前竞态路径，确认真实根因是“慢初始 prompt 预处理 + 快 follow-up 抢跑”
- [x] 在 `ActiveGroupSession` 上增加初始输入缓冲状态与队列
- [x] 调整 `pushMessage()`，在初始 prompt 尚未真正发出前先缓冲 follow-up / steer
- [x] 调整 `handleSessionEvent()` 与初始 `prompt()` 发出后的路径，在 session ready 后冲刷缓冲输入
- [x] 校正 `clearSession()` / dispose 下的关闭标记，避免已关闭 session 继续冲刷缓冲队列
- [x] 在 `tests/feishu-group-adapter.test.ts` 增加复现并覆盖该竞态的测试
- [x] 本地运行相关测试，至少覆盖 `tests/feishu-group-adapter.test.ts` 与受影响的现有测试
