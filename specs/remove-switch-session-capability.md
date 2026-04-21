# 移除 switchSession 能力，收紧 Chat 到当前 Session 的语义

## 问题描述

当前 `octo` 在 `workspace/chat` 模型上已经逐步收敛，但 runtime / CLI 层仍然保留了一条 `switchSession` 能力链：

1. `GroupRuntimeManager.switchSession()`
2. `OctoCliRuntimeHost.switchSession()`
3. 对应测试与相关状态更新逻辑

这条能力的语义是：

1. 给定一个现有的 Pi session jsonl 文件路径
2. 当前 runtime 直接切换到这个 session
3. 如果当前数据库里没有 chat 绑定该 session，系统还会反向创建一个 chat 并绑定过去

这会带来一个核心问题：

1. 当前系统对外想表达的是 `Chat -> current session_ref`
2. 但 `switchSession` 又允许“拿一个 session 文件反向塑造 chat”
3. 结果就是 `Chat` 与 `Session` 的关系不再单向清晰，而是出现双向入口

当前产品目标里，并不希望把“切换到任意旧 session 文件”作为显式能力开放出来，因为这会引起理解歧义：

1. 用户会误以为一个 chat 可以随意切到任意历史 session
2. 会冲淡“一个 chat 有一个当前 session 指针”的基本语义
3. 会让后续 chat / session 关系设计更难收口

因此本次目标是：

1. 移除 `switchSession` 能力
2. 保留 `newSession`
3. 保留 `fork`
4. 保留 `importFromJsonl`
5. 明确系统当前只支持：
   - chat 绑定一个当前 session
   - 通过 `newSession` 切换到新的 session
   - 通过 `fork` 从当前 session 分叉
   - 通过 `importFromJsonl` 在当前 chat 上导入内容

换句话说，本次不是修改 `session_ref` 的底层存储方式，而是先删掉会破坏语义闭合的入口。

## 对现有项目的影响

### 一、Runtime 管理层

影响文件：

1. `src/kernel/group-runtime-manager.ts`
2. `src/kernel/types.ts`

当前问题：

1. `GroupRuntimeManager` 暴露了 `switchSession()`
2. 该方法允许根据 session 文件路径反向查找或创建 chat
3. 这让 runtime 管理器不仅管理“当前 chat 的运行时”，还承担了“从 session 文件恢复 chat 身份”的职责

本次修改：

1. 删除 `GroupRuntimeManager.switchSession()`
2. 删除相关辅助逻辑中仅为 `switchSession()` 服务的路径
3. 保留 `newSession()`、`fork()`、`importFromJsonl()`

### 二、CLI Runtime Host

影响文件：

1. `src/cli/octo-cli-runtime-host.ts`

当前问题：

1. `OctoCliRuntimeHost` 暴露 `switchSession()`
2. 这会向上游调用方暗示“任意 session 文件可切换”是当前支持的正式能力

本次修改：

1. 删除 `OctoCliRuntimeHost.switchSession()`
2. 保持 host 对外的能力集合更贴合当前产品定义

### 三、测试与行为约束

影响文件：

1. `tests/octo-cli-runtime-host.test.ts`
2. 可能涉及 `tests/group-runtime-manager.test.ts` 或其他覆盖 runtime host 行为的测试

当前问题：

1. 现有测试会验证 `switchSession` 的边界
2. 一旦能力删除，这些测试应同步移除或重写

本次修改：

1. 删除 `switchSession` 相关测试
2. 确保保留的 `newSession` / `fork` / `importFromJsonl` 测试仍通过

## 实现方案

### 一、删除 `GroupRuntimeManager.switchSession()`

在 `src/kernel/group-runtime-manager.ts` 中移除整段 `switchSession()` 逻辑，包括：

1. 根据 `sessionPath` 解析 `cwd`
2. 根据 session 文件反查 workspace
3. 根据 `session_ref` 反查 chat
4. 没有 chat 时自动创建 chat 并绑定 session
5. 执行 runtime `switchSession()`

删除后，`GroupRuntimeManager` 仅围绕已知 chat 管理 runtime，不再承担从 session 文件恢复 chat 的职责。

### 二、删除 `OctoCliRuntimeHost.switchSession()`

在 `src/cli/octo-cli-runtime-host.ts` 中移除：

1. `override async switchSession(...)`
2. 对 `manager.switchSession(...)` 的调用

这样 CLI host 暴露出的会话相关能力只剩：

1. `newSession`
2. `fork`
3. `importFromJsonl`

### 三、收紧类型定义

需要检查并更新：

1. `src/kernel/types.ts`
2. 任何显式依赖 `switchSession` 返回结果或约定的类型

目标：

1. 不再在接口层暗示存在“切到任意 session 文件”的能力

### 四、清理测试

需要删除或更新的测试包括：

1. `tests/octo-cli-runtime-host.test.ts` 中所有与 `switchSession` 相关的测试
2. 任何 mock runtime 中仅为 `switchSession` 准备的调用记录和桩实现

保留并重新确认的能力：

1. `newSession`
2. `fork`
3. `importFromJsonl`

### 五、行为边界说明

删除 `switchSession` 后，当前系统对 `Chat` 与 `Session` 的语义应明确为：

1. 一个 chat 只有一个当前 `session_ref`
2. 调用 `newSession` 时，chat 切换到新的 session 文件
3. 旧 session 文件可以继续留在磁盘上
4. 但系统不再提供“直接切到某个旧 session 文件”的正式入口
5. 也不再允许根据某个 session 文件自动反向创建 chat

## Todo List

- [x] 删除 `src/kernel/group-runtime-manager.ts` 中的 `switchSession()` 能力与相关逻辑
- [x] 删除 `src/cli/octo-cli-runtime-host.ts` 中的 `switchSession()` 方法
- [x] 清理 `src/kernel/types.ts` 中与该能力相关的接口暗示
- [x] 删除或更新 `tests/octo-cli-runtime-host.test.ts` 中的 `switchSession` 测试
- [x] 清理相关测试桩中仅为 `switchSession` 准备的 mock 行为
- [x] 运行相关测试，确认 `newSession` / `fork` / `importFromJsonl` 仍正常
