# 收敛运行时输入链与调度编排层，修复入口漂移和状态重复

## 问题描述

当前 `octo` 的底层 runtime 已经基本收敛到 Pi-native，但在“输入预处理、并发控制、路径解析、runtime 生命周期”这几条关键链路上，仍然存在明显的入口漂移和编排重复。它们已经开始带来真实的正确性风险，而不只是代码风格问题。

### 一、不同入口的 prompt 预处理链不一致

当前系统中：

- 飞书入口会在 `FeishuGroupAdapter` 里对输入做统一预处理：
  - legacy 图片语法归一化
  - 图片理解
  - 本地文件链接标注
- CLI / Desktop 入口通过 `GroupRuntimeManager` 直接把原始文本送给 runtime，没有走同一条链路

这意味着相同输入在不同入口下会得到不同的 runtime 视图。例如：

- 飞书里 `![image](media/...)` 会先变成图片理解结果文本
- CLI / Desktop 里相同内容可能直接原样进入模型
- 本地文件路径在飞书里会标注成 agent 可读路径，在 Desktop/CLI 里则不会

这已经不是“体验差异”，而是**行为不一致**。

### 二、Feishu 运行队列的并发控制不是原子的

`FeishuGroupAdapter` 当前使用：

- `locks` 维护 per-workspace 串行
- `activeTasks` + `waitForConcurrencySlot()` 维护全局并发上限

但全局并发控制的实现是：

1. 先轮询等待 slot
2. 再自增 `activeTasks`

这段逻辑不是原子的，多个任务可以在同一个时间窗口同时通过检查，导致瞬时并发超过 `concurrencyLimit`。同时等待实现还是 100ms busy-wait 轮询，会带来额外唤醒和调度噪音。

### 三、`ChannelManager` 仍然隐式依赖 `process.cwd()`

当前 workspace 目录、Desktop sidecar 根目录、runtime 构建都支持显式 `rootDir`。但 `ChannelManager.resolveOutgoingAssetPath()` 在解析相对路径时，仍然直接调用默认 `getWorkspaceDirectory(workspace.folder)`，实际依赖的是进程当前工作目录。

这会导致：

- 在 `rootDir !== process.cwd()` 的 sidecar / 测试环境中解析错误
- 某些资源路径在本地跑得通，换部署方式后失效

### 四、`workspace_runtime_state.unload_after` 已落库但没有形成闭环

当前 `GroupRuntimeManager` 会在 run 结束、branch 切换等路径写入 `workspace_runtime_state.unload_after`，表达“这个 runtime 理论上可以在未来某个时间点卸载”。

但实际上：

- manager 只会在全局 `dispose()` 时统一释放 runtime
- 没有任何后台逻辑按 `unload_after` 真正回收 idle runtime

结果是：

- 数据库里存在一套“计划卸载”状态
- 进程内却没有“执行卸载”的行为
- Desktop sidecar 这种长生命周期进程会持续积累 loaded runtime

这是一种典型的“状态写了但没人消费”的设计不完整。

### 五、`GroupRuntimeManager` 和 `FeishuGroupAdapter` 重复维护 run 生命周期

两套编排器都在做下面几件事：

- 对齐 workspace branch
- 启动 / 结束 run
- 更新 `turn_requests`
- 更新 `runs` / `run_events`
- 持久化 `session_ref`
- 处理 runtime 失败和收尾

这会带来两个问题：

1. 正确性修复需要改两遍，容易漂移
2. 一条链修了，另一条链还保留旧语义

本轮不追求把两套编排器彻底合并，但至少要把**共享状态机和共享辅助逻辑**抽出来，减少继续漂移。

## 对现有项目的影响

### 一、受影响的核心模块

- `src/kernel/group-runtime-manager.ts`
- `src/runtime/feishu-group-adapter.ts`
- `src/channels/manager.ts`
- `src/runtime/pi-group-runtime-factory.ts`
- `src/providers/prompt-normalizer.ts`
- `src/runtime/image-message-preprocessor.ts`
- `src/runtime/group-memory-prompt.ts`
- `src/index.ts`
- `src/cli.ts`
- `src/desktop/main.ts`

### 二、建议新增模块

- `src/runtime/runtime-input-preprocessor.ts`
  - 统一所有入口的输入预处理
- `src/runtime/async-semaphore.ts`
  - 替换当前忙等式并发控制
- `src/runtime/run-lifecycle.ts`
  - 抽取 run / turn request / session_ref / workspace runtime state 的共享落库逻辑

如果实现时发现命名更合适，也可以落在邻近目录，但职责边界应保持一致。

### 三、数据库影响

本轮默认**不新增 schema，不做 migration**。

已有表将继续复用：

- `turn_requests`
- `runs`
- `run_events`
- `workspace_runtime_state`
- `chats`

`workspace_runtime_state.unload_after` 会从“仅写入字段”升级为“真正参与 runtime 回收决策”的字段，但字段本身不变。

### 四、对外行为影响

#### 1. 飞书 / CLI / Desktop 的输入语义会对齐

对用户是正向变化，但有一个真实的行为变化：

- 过去 CLI / Desktop 输入图片或本地文件路径时，模型可能看不到统一预处理结果
- 改完后，这三条入口都会看到同样的图片理解文本和路径标注文本

#### 2. 资源路径解析会更稳定

`send_message` / `send_image` / 富媒体回传在 sidecar 模式下会更可靠。

#### 3. 长生命周期 manager 会开始真正释放 idle runtime

但为了控制风险，默认会加安全条件：

- 没有 active run
- 没有 streaming
- 没有待发送消息
- 没有活跃 UI 监听器时才允许卸载

### 五、测试影响

需要新增或更新以下测试方向：

- 跨入口输入预处理一致性测试
- `FeishuGroupAdapter` 并发上限测试
- `ChannelManager` 在显式 `rootDir` 下的路径解析测试
- `GroupRuntimeManager` idle unload 测试
- `run-lifecycle` 共享模块的单测

## 实现方案

本轮按两个阶段推进：

- **阶段 A：correctness hardening**
  - 统一输入预处理
  - 修复并发控制
  - 显式传递 `rootDir`
  - 让 `unload_after` 真正生效
- **阶段 B：orchestration convergence**
  - 抽取共享 run 生命周期辅助模块
  - 让 `GroupRuntimeManager` 和 `FeishuGroupAdapter` 复用同一套状态更新逻辑

这样可以先解决线上行为不一致和潜在 race，再做结构收敛。

### 一、抽取统一输入预处理器

新增模块：

- `src/runtime/runtime-input-preprocessor.ts`

目标接口：

```ts
export interface RuntimeInputPreprocessor {
  prepare(chatId: string, text: string): Promise<string>;
}

export interface CreateRuntimeInputPreprocessorOptions {
  db: Database;
  rootDir: string;
  workspaceService?: WorkspaceService;
  imageMessagePreprocessor: ImageMessagePreprocessor;
}
```

建议实现：

```ts
export function createRuntimeInputPreprocessor(
  options: CreateRuntimeInputPreprocessorOptions,
): RuntimeInputPreprocessor {
  return {
    async prepare(chatId, text) {
      const chat = resolveChatByIdOrThrow(...);
      const workspace = resolveWorkspaceForChatOrThrow(...);
      const workingDirectory = getWorkspaceDirectory(workspace.folder, {
        rootDir: options.rootDir,
      });

      return normalizePromptForAgent(
        text,
        options.rootDir,
        workingDirectory,
        options.imageMessagePreprocessor,
        "runtime-input-preprocessor",
      );
    },
  };
}
```

#### 架构决策

这里不把预处理逻辑继续散落在各个 orchestrator 内部，而是提升成共享服务，原因是：

1. 输入整形属于“runtime 入场前的通用边界”
2. 它不应附着在某一个 channel 之下
3. 后续如果有 Browser / API / Script 入口，也应该复用这一层

#### 调用方改造

`GroupRuntimeManagerOptions` 增加：

```ts
preparePrompt?: (chatId: string, text: string) => Promise<string>;
```

`GroupRuntimeManager.sendInput()` 改为：

```ts
const normalizedText = await this.preparePrompt(managed.chat.id, input.text);
```

`FeishuGroupAdapter` 保留 `preparePrompt` 扩展点，但默认实现不再自己拼装，而是直接复用 `RuntimeInputPreprocessor`。

#### 入口层改造

以下入口统一创建同一套预处理依赖并传入 manager / adapter：

- `src/index.ts`
- `src/cli.ts`
- `src/desktop/main.ts`

这意味着 CLI 和 Desktop 也要像飞书主进程一样初始化：

- `MiniMaxTokenPlanMcpClient`
- `DatabaseImageMessagePreprocessor`
- `RuntimeInputPreprocessor`

如果 `MINIMAX_API_KEY` 缺失，则沿用现有降级策略，图片预处理输出失败占位文本，不阻断流程。

### 二、用异步信号量替换忙等式并发控制

新增模块：

- `src/runtime/async-semaphore.ts`

建议接口：

```ts
export class AsyncSemaphore {
  constructor(limit: number);
  acquire(): Promise<() => void>;
}
```

使用方式：

```ts
const release = await semaphore.acquire();
try {
  await runTask();
} finally {
  release();
}
```

#### 改造原则

`FeishuGroupAdapter` 当前已经通过 `locks` 保证同一个 workspace 串行，因此新的并发模型应是：

- `locks` 继续负责 per-workspace 串行
- `AsyncSemaphore` 负责全局并发上限

删除：

- `waitForConcurrencySlot()`
- `activeTasks` 的手工 busy-wait 协调逻辑

保留：

- `activeSessions`
  - 它负责 follow-up / steer / clear-session 等 active session 语义，不等同于并发控制

#### 架构收益

1. 并发上限变成严格保证，不再依赖时间窗口
2. 不再有 100ms 轮询
3. 代码语义更直接，可测试性更高

### 三、给 `ChannelManager` 显式注入 `rootDir`

当前问题是 `ChannelManager` 在路径解析上使用了默认 `process.cwd()` 语义。

建议改造：

```ts
export interface ChannelManagerOptions {
  rootDir?: string;
}

export class ChannelManager {
  constructor(
    db: Database,
    options: ChannelManagerOptions = {},
  ) {}
}
```

内部保存：

```ts
private readonly rootDir: string;
```

然后把：

```ts
const workspaceDir = getWorkspaceDirectory(workspace.folder);
```

改成：

```ts
const workspaceDir = getWorkspaceDirectory(workspace.folder, {
  rootDir: this.rootDir,
});
```

所有实例化点同步改造：

- `src/index.ts`
- `src/cli.ts`
- `src/desktop/main.ts`

#### 设计原则

路径解析属于环境依赖，不应隐式依赖进程 cwd。凡是已经支持 `rootDir` 的核心服务，都要沿着同一条边界把它显式传下去。

### 四、让 `unload_after` 真正参与 idle runtime 回收

当前 `GroupRuntimeManager` 已经会写入 `unload_after`，但没有回收行为。

建议新增 manager 内部方法：

```ts
pruneIdleRuntimes(now = new Date()): Promise<void>
```

判断条件：

- `managed.currentRunId === null`
- `managed.runtime.session.isStreaming === false`
- 当前 chat 没有待处理 queue 状态
- 当前 chat 没有活跃监听器
- `workspace_runtime_state.unload_after <= now`

回收动作：

1. `managed.unsubscribeSession()`
2. `await managed.runtime.dispose()`
3. `this.runtimes.delete(chat.id)`

#### 触发策略

为降低风险，不在所有 manager 上默认启用后台回收线程，而是：

- `GroupRuntimeManager` 提供显式 `pruneIdleRuntimes()` 能力
- `src/desktop/main.ts` 为 sidecar 启动一个定时 prune loop
- CLI 模式默认不启用后台 prune

原因：

- CLI 有活跃交互界面，自动卸载当前 runtime 价值不大
- Desktop sidecar 更像长生命周期后台进程，最需要 idle 回收

#### 额外安全约束

如果 chat 有活跃 SSE 订阅，不回收对应 runtime。这样可以避免 UI 在仍然观察该 chat 时 runtime 被突然释放。

### 五、抽取共享 run 生命周期辅助层

新增模块：

- `src/runtime/run-lifecycle.ts`

先不直接引入一个过大的“统一 orchestrator”，而是先抽共享的状态更新原语：

```ts
export function startPersistedRun(...): RunRow;
export function finishPersistedRun(...): void;
export function persistChatSessionRef(...): ChatRow | null;
export function ensureWorkspaceOnChatBranch(...): void;
export function appendPersistedRuntimeEvent(...): void;
```

#### 第一版职责边界

这层只负责：

- DB 落库
- branch 对齐
- runtime state 更新

不负责：

- session 事件订阅
- message 流转
- channel 回包
- follow_up / steer 排队

#### 为什么先抽“原语层”而不是“一次性大合并”

因为当前两套 orchestrator 的使用场景不同：

- `GroupRuntimeManager` 偏长生命周期交互式 runtime
- `FeishuGroupAdapter` 偏短生命周期 queue worker

它们短期内不适合直接强行合并成一个类。更稳妥的路线是：

1. 先抽共享状态机与共享持久化原语
2. 把明显重复的逻辑迁走
3. 后续如果两者的调用形态继续靠近，再考虑更高阶合并

### 六、测试设计

#### 1. 统一输入预处理测试

新增测试覆盖：

- 同一条输入在 `GroupRuntimeManager` 和 `FeishuGroupAdapter` 下调用同一 `preparePrompt`
- 图片输入在三种入口配置下得到一致的 prompt 结果
- 本地 markdown 文件链接得到一致的 agent 可读路径标注

建议文件：

- `tests/runtime-input-preprocessor.test.ts`
- `tests/runtime-manager-prompt-normalization.test.ts`

#### 2. 并发上限测试

新增测试覆盖：

- `concurrencyLimit = 1/2/3` 时不会超限
- 同 workspace 多 turn request 会严格串行
- 不同 workspace 会在全局上限内并发执行

建议文件：

- `tests/feishu-group-adapter-concurrency.test.ts`

#### 3. `rootDir` 路径解析测试

新增测试覆盖：

- `ChannelManager` 在自定义 `rootDir` 下能正确解析相对文件路径
- 越界路径仍然被拒绝

建议文件：

- `tests/channel-manager-rootdir.test.ts`

#### 4. idle unload 测试

新增测试覆盖：

- `unload_after` 已到且无监听器时，runtime 被释放
- 有 listener / active run / streaming 时，不会释放

建议文件：

- `tests/group-runtime-manager-idle-unload.test.ts`

#### 5. run lifecycle 原语测试

新增测试覆盖：

- `startPersistedRun()` 写入 `runs`、`run_events`、`workspace_runtime_state`
- `finishPersistedRun()` 正确收尾并写错误态
- `persistChatSessionRef()` 正确刷新 `last_activity_at`

建议文件：

- `tests/run-lifecycle.test.ts`

## Todo List

- [x] 阶段 A.1：新增 `src/runtime/runtime-input-preprocessor.ts`，统一封装图片理解、本地文件标注和 working directory 解析
- [x] 阶段 A.2：给 `GroupRuntimeManagerOptions` 增加 `preparePrompt`，让 CLI / Desktop 链路走统一输入预处理
- [x] 阶段 A.3：改造 `src/index.ts`、`src/cli.ts`、`src/desktop/main.ts`，统一初始化 `MiniMaxTokenPlanMcpClient`、`DatabaseImageMessagePreprocessor` 和 `RuntimeInputPreprocessor`
- [x] 阶段 A.4：保留现有降级策略，补齐未配置 `MINIMAX_API_KEY` 时的日志和测试覆盖
- [x] 阶段 A.5：新增 `src/runtime/async-semaphore.ts`
- [x] 阶段 A.6：移除 `FeishuGroupAdapter.waitForConcurrencySlot()` 忙等逻辑，改为 `AsyncSemaphore` + 现有 `locks`
- [x] 阶段 A.7：补充 `FeishuGroupAdapter` 并发上限与 workspace 串行测试
- [x] 阶段 A.8：给 `ChannelManager` 新增 `rootDir` 选项并贯通所有实例化点
- [x] 阶段 A.9：补充 `ChannelManager` 在自定义 `rootDir` 下的路径解析测试
- [x] 阶段 A.10：在 `GroupRuntimeManager` 中新增 `pruneIdleRuntimes()`，按 `unload_after` 回收 idle runtime
- [x] 阶段 A.11：在 `src/desktop/main.ts` 中为 sidecar 启动 idle prune loop，并在 stop 时清理 timer
- [x] 阶段 A.12：补充 idle unload 的单测和 sidecar 级验证
- [x] 阶段 B.1：新增 `src/runtime/run-lifecycle.ts`，抽取共享 run 持久化与 branch 对齐原语
- [x] 阶段 B.2：让 `GroupRuntimeManager` 改为复用 `run-lifecycle` 原语，删除内部重复落库逻辑
- [x] 阶段 B.3：让 `FeishuGroupAdapter` 改为复用 `run-lifecycle` 原语，删除内部重复落库逻辑
- [x] 阶段 B.4：补充 `run-lifecycle` 单测，覆盖完成、失败、取消和 session_ref 更新路径
- [x] 阶段 B.5：回归 `Desktop API`、`CLI`、`Feishu` 三条主链路，确认 snapshot、SSE 事件、错误回包和 `/clear` 不回归
- [x] 阶段 B.6：更新相关文档，补充新的输入预处理边界、并发模型和 idle unload 行为说明

## 实施顺序说明

本 spec 明确要求先做阶段 A，再做阶段 B。

原因是：

1. 阶段 A 解决的是 correctness 和环境一致性问题，收益直接
2. 阶段 B 是结构收敛，适合建立在阶段 A 行为稳定之后
3. 如果阶段 A 中发现某些现有假设不成立，阶段 B 的抽象边界还可以继续调整

## 非目标

本轮不包含以下改动：

- 不重写 `FeishuChannel`
- 不更换 Pi runtime SDK
- 不新增数据库表
- 不把 `GroupRuntimeManager` 和 `FeishuGroupAdapter` 强制合并成单一类
- 不调整现有 Workspace / Chat / Run 域模型

这些问题可以在后续单独 spec 中继续推进，但不应混入本轮 hardening。
