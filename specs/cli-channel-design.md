# CLI / Feishu 与 Pi 融合设计

## 问题描述

当前 `octo` 已经把底层执行统一到 `PiProvider`，但入口仍然主要围绕飞书设计。现在目标不是简单新增一个“本地聊天入口”，而是要把 `octo` 的核心边界重新收敛清楚：

1. `octo` 唯一必须守住的原则是：**多 group**，且**每个 group 都有自己完整的一套环境**
2. `group` 才是真正的状态单位，负责：
   - 工作目录
   - profile
   - group memory
   - `.pi/skills`
   - `.pi/sessions`
   - 任务与后台管理归属
3. `channel` 只是入口/出口，不应该反过来定义 group 语义
4. `group` 内部的 AI runtime 可以直接适配 `pi`

在这个前提下，需要回答三个设计问题：

1. `pi` 本身是否支持“飞书 / CLI / Slack”这类外部 channel 抽象？
2. 如果 CLI 要尽量复用 `pi coding-agent` 的 `InteractiveMode`，应该怎么和 Octo 的 group 模型融合？
3. 飞书 channel 应该继续保持现状，还是也要一起调整成“Octo group 外壳 + Pi group runtime”的结构？

## 现状与结论

### 一、Octo 当前的主单位其实已经是 group

从现有代码看，真正承载状态的是 group，而不是 channel：

1. `registered_groups` 保存 group 元数据
   - [src/db.ts](/Volumes/Extra/work/kkdashu/octo/src/db.ts)
2. `router` 按 `group.jid` 聚合消息
   - [src/router.ts](/Volumes/Extra/work/kkdashu/octo/src/router.ts)
3. `GroupQueue` 按 `group.folder` 管工作目录、memory、Pi session ref 和并发
   - [src/group-queue.ts](/Volumes/Extra/work/kkdashu/octo/src/group-queue.ts)
4. `ChannelManager` 只负责根据 `group.channel_type` 把消息发回正确入口
   - [src/channels/manager.ts](/Volumes/Extra/work/kkdashu/octo/src/channels/manager.ts)
5. 现有 `Channel` 接口本身也只描述 I/O，没有 runtime 语义
   - [src/channels/types.ts](/Volumes/Extra/work/kkdashu/octo/src/channels/types.ts)

所以 Octo 当前最清晰的抽象应当明确写成：

```text
group   = 完整环境与状态边界
channel = 入口/出口适配器
pi      = group 内部的 agent runtime / UI runtime
```

### 二、Pi 本身没有“外部 channel”抽象

这点需要明确，不然后面会一直误判复用边界。

从 `pi-mono/packages/coding-agent` 看，Pi 提供的是几种**运行模式**，不是外部消息渠道：

1. `interactive`
2. `print`
3. `json`
4. `rpc`

参考：

- [pi-mono/packages/coding-agent/src/main.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/main.ts)
- [pi-mono/packages/coding-agent/src/modes/index.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/index.ts)

也就是说，Pi 的思路是：

```text
同一个 AgentSession / AgentSessionRuntime
  可以被不同 mode 驱动
  但它不关心 Feishu / CLI / Slack / Webhook 这些“业务渠道”
```

Pi 最接近“给别的前端复用”的能力是：

1. `InteractiveMode`
   - 本地终端 TUI
2. `runRpcMode()`
   - 用 JSONL stdin/stdout 协议把 runtime 暴露给外部宿主

参考：

- [pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts)

因此结论很直接：

### 结论 1

**Pi 本身不负责多 channel。**

它负责的是：

1. 单个 session/group 内的 agent runtime
2. TUI 或 RPC 交互模式
3. 完整事件流和 session 管理

外部 channel 归属应该仍然由 Octo 管。

### 三、Pi 的 runtime 能力远比 Octo 当前 `AgentRuntime` 抽象厚

Octo 当前 provider 抽象很薄：

- `openConversation()`
- `resetSession()`
- 事件只有 `assistant_text / completed / failed / diagnostic`

参考：

- [src/providers/types.ts](/Volumes/Extra/work/kkdashu/octo/src/providers/types.ts)

而 Pi 的 `InteractiveMode` 绑定的是完整 `AgentSessionRuntime` / `AgentSession`，它依赖：

1. 真实 session 对象
2. session 文件与 session manager
3. 丰富事件流
   - `message_start`
   - `message_update`
   - `message_end`
   - `queue_update`
   - compaction / retry / tool execution 等
4. 直接访问 session state
   - `messages`
   - `sessionFile`
   - `sessionName`
   - `pendingMessageCount`
   - `settingsManager`
   - `resourceLoader`

参考：

- [pi-mono/packages/coding-agent/src/core/agent-session.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/agent-session.ts)
- [pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts)

因此结论不是“改一下消息类型就能复用 `InteractiveMode`”，而是：

### 结论 2

**如果要完整复用 Pi 的 `InteractiveMode`，CLI 必须直接运行在 Pi-native runtime 之上。**

不能强行让 `InteractiveMode` 走 Octo 当前这层薄 `AgentRuntime`。

## 设计原则

本次方案收敛到以下原则：

1. `Octo` 只负责 group 生命周期与 group 元数据
2. 每个 group 保持自己完整环境，不破坏现有 folder/profile/memory/task 边界
3. `Pi` 负责 group 内部的 agent runtime、session 文件、TUI/RPC 交互
4. `channel` 只是把外部输入映射进某个 group，再把 group 输出发回去
5. 第一阶段不支持“同一个 group 同时挂飞书和 CLI”

换句话说：

```text
Octo = group control plane
Pi   = group execution plane
```

## 推荐架构

## 一、顶层模型

推荐把整体结构分成两层：

### 1. Octo Group Control Plane

职责：

1. 创建 group
2. 列出 / 切换 / 重命名 group
3. 维护 `registered_groups`
4. 初始化 `groups/<folder>/`
5. 管理 profile / memory / tasks / admin 元数据
6. 决定一个 group 属于哪个 channel 类型

### 2. Group Runtime Plane

职责：

1. 在 `groups/<folder>/` 内启动或恢复 Pi runtime
2. 维护该 group 的 `.pi/sessions`
3. 处理该 group 内的 session clear / compaction / tool execution
4. 向具体入口暴露事件

也就是：

```text
Octo 管 group
Pi 管 group 内的 agent session
```

这正好符合用户要求：

- Octo 负责 group 管理
- group 内部可以适配 Pi

## 二、CLI 的推荐落地方式

### 目标语义

CLI 里的顶层“session”在 Octo 语义上仍然是 group：

- CLI `/new-group` = 新建 Octo group
- CLI `/switch-group` = 切换 Octo group
- CLI `/groups` = 列出 Octo 的 CLI groups

而 Pi 自己的 session 概念下沉到 group 内部：

- Pi `new_session` 更接近当前 group 内 `/clear`
- Pi `switch_session` / `fork` 属于 group 内部历史能力

因此 CLI 要分两层语义：

### 外层：Octo group 命令

1. `/new-group`
2. `/groups`
3. `/switch-group`
4. `/rename-group`

这些命令不进入 AI 上下文，也不属于 Pi 原生命令。

### 内层：Pi session 命令

1. `/clear` 或等价命令
2. `/compact`
3. `/fork`
4. `/tree`
5. 其它 group 内 session 能力

这些属于当前 group 内部 runtime。

## 三、CLI 是否能“完整复用” `InteractiveMode`

### 结论

如果坚持把 Octo 的 group 命令也命名成 Pi 内建命令，例如：

```text
/new = 新建 group
/resume = 切换 group
```

那么 **零改动直接复用，不行**。

原因只有一个，但很关键：

Pi 内建把 `/new` 解释成“新建 session”，不是“新建 Octo group”。

参考：

- [pi-mono/packages/coding-agent/src/core/slash-commands.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/slash-commands.ts)
- [pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts)

所以如果你的产品语义是：

```text
/new = 新建 group
```

那么必须处理命令冲突。

更具体地说：

1. `InteractiveMode` 自己先处理内建命令，再进入 `session.prompt()`
2. extension command 是在 `session.prompt()` 中执行的
3. 因此 extension 不能覆盖 interactive mode 里已经先吃掉的 `/new`
4. autocomplete 里若 extension command 与 built-in 同名，也只会给出冲突提示，不会替换 built-in

也就是说：

- `/new` 不能靠 extension 覆盖成“新建 group”
- `/resume` 也不适合作为“切换 group”的扩展别名

### 推荐方案

**不改 Pi 源码，完整复用 `InteractiveMode` 本体，并通过 extension 增加一组新的 Octo group 命令。**

推荐命令集：

1. `/new-group`
2. `/groups`
3. `/switch-group`
4. `/rename-group`

这组命令与 Pi 内建命令不冲突，因此可以直接通过 extension 注册。

Pi 已经支持：

1. extension 注册 command
2. `InteractiveMode` 自动把 extension commands 加入 slash autocomplete
3. project-local extension 放在 `cwd/.pi/extensions/`

参考：

- [pi-mono/packages/coding-agent/src/core/extensions/types.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/extensions/types.ts)
- [pi-mono/packages/coding-agent/src/core/extensions/loader.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/extensions/loader.ts)
- [pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts)

在这个方案下，语义变成：

1. `/new-group`
   - 新建 Octo group，并切换到该 group 对应 runtime
2. `/switch-group`
   - 切换到另一个 Octo group
3. `/groups`
   - 列出现有 groups，支持 picker
4. `/rename-group`
   - 修改当前 group 显示名
5. Pi 内建 `/new`
   - 保留 Pi 原语义
   - 在 Octo 文档里把它定义为“当前 group 内清空上下文 / 新建内部 session”

这个方案的最大优点是：

### 结论 3A

**CLI 第一阶段可以不改 Pi 源码，不 fork `InteractiveMode`，直接通过 extension 实现 Octo 的 group 命令。**

也就是：

1. 保持 Pi `InteractiveMode` 原样
2. 用 extension 增加 `/new-group` / `/switch-group` / `/groups` / `/rename-group`
3. 把 Pi 内建 `/new` 当作 group 内部 session clear 能力

这样最符合“先上 Pi-native runtime，且不改 Pi 源码”的目标。

## 四、Feishu 的推荐落地方式

飞书不应该去复用 `InteractiveMode`，因为它不是本地终端 UI。

飞书应该被重新定义为：

### `FeishuChannel = Octo 的远程入口适配器`

它负责：

1. 接收飞书事件
2. 定位或创建对应 group
3. 把消息投递给该 group 的 runtime
4. 将 runtime 输出回写到飞书

也就是说，飞书层应该尽量薄，不应该承担 session 语义或 UI 语义。

## 五、Feishu 统一收敛到 group runtime adapter

链路：

```text
FeishuChannel
  -> Octo group lookup
  -> GroupRuntimeHost(group)
  -> Pi runtime
  -> event adapter
  -> FeishuChannel.sendMessage()
```

这是当前明确选择的目标架构，不再把 `GroupQueue -> PiProvider` 旧链路作为正式方案保留在设计里。

优点：

1. CLI 和飞书统一落到同一个 group runtime 模型
2. group 语义更纯
3. 后续任意新 channel 都只是入口适配
4. 现有 `PiProvider` 薄抽象可以逐步退出主路径

代价：

1. 改造面比只做 CLI 大
2. 需要重新定义 Feishu 的流式输出、并发和 session 持久化边界

实现顺序上可以先完成 CLI 的 Pi-native runtime 路径，再把 Feishu 迁移到同一套 group runtime adapter；但这只是施工顺序，不代表最终保留两套长期并存的行为模型。

## 六、为什么这个方向比“所有 channel 都走薄 provider”更合理

因为你的核心原则是：

```text
多 group
每个 group 一套完整环境
Octo 负责 group 管理
group 内部适配 Pi
```

一旦接受这个原则，最自然的结构就是：

1. group 是一级对象
2. Pi runtime 是 group 内部对象
3. channel 是 group 外围适配器

而不是：

1. channel 驱动消息
2. provider 临时开会话
3. group 只当数据库标签

后者会不断和你想要的 CLI / TUI / richer session 能力打架。

## 对现有项目的影响

需要影响的模块大致如下：

1. group 创建与初始化逻辑
   - 需要从 [src/index.ts](/Volumes/Extra/work/kkdashu/octo/src/index.ts) 抽出公共 bootstrap / setup
2. channel 层
   - 飞书继续做入口适配
   - 新增 CLI 入口适配
3. runtime 层
   - 新增 group runtime host / adapter
   - 不再只依赖当前薄 `AgentRuntime`
4. session 持久化
   - group 下继续保留 `.pi/sessions`
   - 第一阶段继续使用 Octo DB 的 `sessions.session_ref` 记录当前活跃 session
5. UI 层
   - CLI 第一阶段基于 `InteractiveMode` + Octo extension

## 实现方案

## Phase 1：先建立统一的 group 控制面

目标：

1. 抽出 `GroupService`
2. 显式支持创建 `channel_type = "cli"` 的 group
3. 统一 group 初始化流程

建议新增：

1. `src/app.ts`
   - 服务装配与 bootstrap
2. `src/group-service.ts`
   - `createGroup`
   - `renameGroup`
   - `listGroups`
   - 查询可切换 group
3. `src/runtime/pi-group-runtime-factory.ts`
   - 先抽出 group -> Pi runtime 的共享构造逻辑

## Phase 2：CLI 走 Pi-native InteractiveMode

目标：

1. 新增 `octo cli`
2. 外层命令做 group 管理
3. 当前 group 内使用 Pi runtime
4. 第一阶段不改 Pi 源码，直接复用 Pi 的 InteractiveMode UI

建议实现：

1. `src/cli.ts`
   - CLI 入口
2. `src/cli/octo-group-extension.ts`
   - 注册 `/new-group`
   - 注册 `/groups`
   - 注册 `/switch-group`
   - 注册 `/rename-group`
3. `src/cli/group-selector.ts`
   - group picker
4. 通过 group runtime 构造 Pi `AgentSessionRuntime`
5. 将 extension 以 runtime 注入方式挂到当前 group 的 resource / extension loader

### CLI extension 注入策略

第一阶段采用：

- **runtime 注入**

不采用：

- 将 `octo-group-extension` 写入每个 group 的 `groups/<folder>/.pi/extensions/`

原因：

1. `octo-group-extension` 属于 Octo 平台控制面能力，不属于某个 group 的项目资源
2. runtime 注入只维护一份代码，升级后所有 group 在下次启动时自动生效
3. 避免把 Octo 平台逻辑复制到每个 group 目录，减少版本漂移与迁移成本
4. 保留 `groups/<folder>/.pi/extensions/` 给用户或项目自己的 group-specific 扩展

需要接受的限制：

1. 如果用户脱离 Octo，直接进入某个 group 目录运行原生 `pi`，则看不到 `/new-group`、`/groups`、`/switch-group`、`/rename-group`
2. 这组命令只在 Octo 启动并注入 runtime 的场景里存在

这项限制在第一阶段是可接受的，因为 CLI 本身就是 Octo 的本地前端，而不是要求每个 group 目录都能脱离 Octo 独立承载 group 管理能力。

### CLI runtime 构造方案

CLI 不再经过当前的薄 `PiProvider.openConversation()` 链路，而是直接采用 Pi 官方推荐的 runtime 组装方式：

1. `createAgentSessionServices()`
2. `createAgentSessionFromServices()`
3. `createAgentSessionRuntime()`

参考：

- [pi-mono/packages/coding-agent/src/core/agent-session-services.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/agent-session-services.ts)
- [pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts)
- [pi-mono/packages/coding-agent/src/main.ts](/Volumes/Extra/work/kkdashu/octo/pi-mono/packages/coding-agent/src/main.ts)

推荐新增：

1. `src/runtime/pi-group-runtime-factory.ts`
   - 负责按 group 组装 Pi runtime
   - 未来可被 CLI 与 Feishu 共用
2. `src/cli/octo-cli-runtime-host.ts`
   - 包装 Pi `AgentSessionRuntime`
   - 负责 group 级别的切换与 `session_ref` 持久化

其中 `pi-group-runtime-factory.ts` 需要复用并抽离当前 [src/providers/pi.ts](/Volumes/Extra/work/kkdashu/octo/src/providers/pi.ts) 里的几块逻辑：

1. 按 `group.profile_key` 解析 `ResolvedAgentProfile`
2. 按 profile 构建 in-memory `ModelRegistry`
3. 组装 `DefaultResourceLoader`
4. 注入 `mcpBundle.extensionFactories`
5. 复用 `createGroupToolDefs()` 构造 Octo group tools

这样 CLI 与未来 Feishu runtime adapter 才能共享同一套“group -> Pi runtime”构造规则，而不是继续分叉。

### 为什么首期优先 `inline extension factory`

虽然 runtime 注入可以通过两种方式实现：

1. `additionalExtensionPaths`
2. `extensionFactories`

但第一阶段推荐明确选：

- **`extensionFactories`（inline extension factory）**

不优先选：

- `additionalExtensionPaths`

原因：

1. `octo-group-extension` 需要直接调用 Octo 的 `GroupService`、CLI state、runtime switch 回调
2. inline factory 可以直接闭包捕获这些对象，不需要再通过磁盘文件 + import 链路传参
3. 避免在 Bun binary / workspace / 相对路径场景下处理额外的 extension path 解析问题
4. Octo 当前已经有现成先例：
   - [src/providers/pi-mcp-extension.ts](/Volumes/Extra/work/kkdashu/octo/src/providers/pi-mcp-extension.ts)
   - 它也是通过 `extensionFactories` 把运行时依赖注入到 Pi

因此第一阶段建议：

```text
octo-group-extension = createOctoGroupExtensionFactory(deps)
deps = { groupService, cliStateStore, runtimeHost, db, channelManager? }
```

### `OctoCliRuntimeHost` 的职责

首期建议不要把原始 `AgentSessionRuntime` 直接暴露给 `InteractiveMode`，而是包一层 `OctoCliRuntimeHost`。

这个对象需要在公开 API 上尽量兼容 Pi 的 `AgentSessionRuntime`，至少覆盖：

1. `session`
2. `services`
3. `cwd`
4. `diagnostics`
5. `modelFallbackMessage`
6. `newSession()`
7. `switchSession()`
8. `fork()`
9. `importFromJsonl()`
10. `dispose()`

这么做不是为了改 Pi UI，而是为了解决 Octo 自己必须维护的状态：

1. 当前 CLI group
2. `sessions.session_ref`
3. CLI 最近使用 group 状态
4. group 边界校验

也就是：

```text
InteractiveMode
  -> OctoCliRuntimeHost
    -> AgentSessionRuntime
```

### `OctoCliRuntimeHost` 需要做的拦截

#### 1. `newSession()`

Pi 内建 `/new` 会走这个方法。

这里必须在成功后：

1. 读取新的 `session.sessionFile`
2. 持久化到 Octo `sessions.session_ref`
3. 仍然保持当前 group 不变

这正好把 Pi 的 `/new` 解释成：

- 当前 group 内部的新 session

#### 2. `fork()`

成功后同样要：

1. 读取新的 `session.sessionFile`
2. 更新当前 group 的 `session_ref`

#### 3. `switchSession(sessionPath)`

这个方法不只是给 Pi 的 `/resume` 用，也给 Octo 的 `/switch-group` / `/new-group` 用。

它需要：

1. 先从目标 `sessionPath` 解析 session header 里的 `cwd`
2. 把 `cwd` 反查为某个已注册 Octo group
3. 仅允许切到合法 group
4. 成功后更新：
   - 当前 group folder
   - 目标 group 的 `session_ref`
   - CLI 最近使用 group 状态

这层校验很重要，因为第一阶段我们不改 Pi 的 `InteractiveMode`，所以 Pi 内建 `/resume` 仍然存在。必须靠 host 层拦住“切到 Octo registry 之外的 session”。

#### 4. `importFromJsonl(inputPath, cwdOverride?)`

第一阶段建议保守处理：

1. 仅允许导入到当前 group
2. 若导入后的 session cwd 与当前 group workdir 不一致，则拒绝
3. 成功后更新当前 group 的 `session_ref`

原因：

- `/import` 属于 Pi 的低层 session 能力
- 若允许它把 cwd 带到任意目录，会破坏 Octo 的 group 边界

### group 进入与切换的 session 解析策略

进入某个 group 时，不应只依赖当前数据库里的 `session_ref`。推荐统一用下面的顺序：

1. 若 `sessions.session_ref` 存在且文件存在，优先使用它
2. 否则若 `groups/<folder>/.pi/sessions/` 下存在历史 session，取最近一个
3. 否则创建一个 fresh session
4. 将最终选中的 session 文件回写到 `sessions.session_ref`

这样可以兼容：

1. 旧 group 已有 `.pi/sessions`，但还没写入数据库
2. `session_ref` 指向的文件已经被删除
3. 新创建的 CLI group 尚无任何 session

### `/new-group` / `/switch-group` 的真实执行路径

首期不需要重启整个 `InteractiveMode`。

推荐直接复用 Pi 自己的 runtime 切换能力：

1. `GroupService` 创建或定位目标 group
2. 解析该 group 应进入的 session 文件
3. 调用 `OctoCliRuntimeHost.switchSession(targetSessionPath)`
4. 由底层 `AgentSessionRuntime` 完成 services / cwd / session 的重建
5. `InteractiveMode` 按 Pi 原逻辑刷新 UI

也就是说：

```text
/new-group
  -> GroupService.createCliGroup()
  -> resolveTargetSession()
  -> runtimeHost.switchSession(targetSessionPath)

/switch-group
  -> GroupService.findCliGroup()
  -> resolveTargetSession()
  -> runtimeHost.switchSession(targetSessionPath)
```

这种做法的好处是：

1. 不需要重启整个 TUI
2. 复用 Pi 现有的 session/runtime 切换机制
3. 切换 group 时会自然刷新 tools、resourceLoader、cwd、profile

### `/groups` 的 UI 实现

第一阶段实现成真正的 picker，而不是纯文本打印。

实现顺序：

1. 命令带参数时直接解析
   - `/switch-group <folder>`
   - `/rename-group <name>`
2. 不带参数时打开 picker

第一阶段不改 Pi 源码，因此先采用 Pi 原生 `ctx.ui.select()` 做 picker，保持：

1. slash command 入口和原生 UI 体验一致
2. 无需 fork `InteractiveMode`
3. `src/cli/group-selector.ts` 仍然保留为 Octo group 语义封装层

如果后续要进一步贴近 `SessionSelectorComponent` 的视觉层级，再把 `group-selector.ts` 升级成 `ctx.ui.custom()` overlay。

### 内建 Pi 命令在第一阶段的定位

第一阶段不改 Pi 源码，因此下面这些内建命令继续存在：

1. `/new`
2. `/resume`
3. `/import`
4. `/name`

推荐将它们定义为：

#### `/new`

- 合法
- 语义：当前 group 内开新 session

#### `/resume`

- 保留，但属于低层能力
- 最终能否切换成功由 `OctoCliRuntimeHost.switchSession()` 校验
- UX 不是第一阶段重点，不保证它展示出来的所有 session 都可切换

#### `/import`

- 保留，但受当前 group 边界约束
- 不能借此把 CLI runtime 带出 Octo group

#### `/name`

- 仅修改 Pi session display name
- 不等价于 Octo group rename
- Octo group rename 仍然使用 `/rename-group`

### CLI 进程启动与退出生命周期

推荐的 CLI 启动顺序：

1. 打开 Octo 数据库
2. 初始化 `GroupService`
3. 加载 CLI 本地状态（最近使用 group）
4. 解析初始 group：
   - `--group <folder>` 优先
   - 否则最近使用 group
   - 否则自动创建一个新的 CLI group
5. 构造 `OctoCliRuntimeHost`
6. 用该 host 启动 Pi `InteractiveMode`

CLI 退出时：

1. 保存最近使用 group
2. 调用 `runtimeHost.dispose()`
3. 不影响其它 channel 的 group 数据

### CLI runtime 与现有 tools 的关系

第一阶段建议保留现有 Octo tools 体系，不为 CLI 单独发明一套。

具体做法：

1. CLI runtime 仍调用 `createGroupToolDefs()`
2. 为其提供一份 CLI 侧 `MessageSender`
3. `MessageSender` 继续通过 `ChannelManager` 完成对 Feishu 等 channel 的出站发送

这点是可行的，因为当前 [src/channels/feishu.ts](/Volumes/Extra/work/kkdashu/octo/src/channels/feishu.ts) 中的 `sendMessage()` / `sendImage()` / `listChats()` 不依赖 `start()` 之后的长连接事件循环，CLI 进程可以只使用其出站能力

这样可以保证：

1. CLI group 内的 agent 仍可使用现有 group tools
2. 工具行为尽量与 Feishu path 一致
3. 第二阶段迁移 Feishu 时复用面更大

## Phase 3：Feishu 渐进收敛到 group runtime adapter

目标：

1. 飞书不再感知 provider 细节
2. 飞书只负责消息 ingress/egress
3. group 内执行统一交给 runtime host

建议实现：

1. `src/channels/feishu.ts`
   - 保留 I/O 适配职责
2. `src/runtime/feishu-group-adapter.ts`
   - 将飞书消息映射到 group runtime

Feishu 出站事件边界第一阶段收敛为：

1. 文本、图片、文件仍统一走 `ChannelManager.send()`
2. 富媒体边界继续沿用当前 Markdown parts 解析能力，不在 Feishu adapter 内重新发明一套消息格式
3. Pi `message_update` 不直接映射到飞书分片编辑
4. Pi `message_end` 作为单条飞书消息的发送边界
5. `session.prompt()` 解析完成并回写 `sessions.session_ref` 作为 turn 完成边界

## 关键决策

### 决策 1

CLI 的顶层“session”在产品语义上就是 Octo group，不是 Pi session file。

### 决策 2

Pi 原生 `/new` 语义与 Octo group 创建语义冲突，因此第一阶段不复用 `/new`，而是新增 `/new-group` 等 extension commands。

### 决策 3

飞书不应被实现成 Pi 的“另一种 mode”，而应继续作为 Octo 的 channel adapter。

### 决策 4

CLI 与 Feishu 都收敛到统一的 `group runtime host`，不保留两套长期并存的执行抽象。

### 决策 5

第一阶段优先“零改 Pi 源码”路线：

1. 通过 extension 扩展 group 命令
2. 不覆盖 Pi 内建 slash commands
3. 将 Pi 内建 `/new` 视为 group 内部 session 操作

### 决策 6

`octo-group-extension` 第一阶段采用 runtime 注入，而不是写入每个 group 的 `.pi/extensions/`。

### 决策 7

runtime 注入的具体实现选择 `extensionFactories`，不选择 `additionalExtensionPaths`。

### 决策 8

第一阶段继续保留并复用 Octo 数据库里的 `sessions.session_ref`，作为“每个 group 当前活跃 session”的稳定指针。

### 决策 9

第一阶段允许 Pi 内建 `/resume` / `/import` 继续存在，但必须由 `OctoCliRuntimeHost` 在 runtime 层做 group 边界校验。

### 决策 10

Feishu 的目标架构固定为 group runtime adapter，不再把 `GroupQueue -> PiProvider` 当作正式长期方案。

## Todo List

- [x] 抽出公共 group bootstrap / setup 逻辑，避免 `src/index.ts` 写死只服务飞书
- [x] 设计 `GroupService`，统一 group 的创建、列出、改名、查询能力
- [x] 抽出 `pi-group-runtime-factory`，统一 CLI 与未来 Feishu 的 group -> Pi runtime 构造逻辑
- [x] 实现 `OctoCliRuntimeHost`，包装 Pi `AgentSessionRuntime`
- [x] 明确并实现 `sessions.session_ref` 的更新时机：`newSession` / `fork` / `switchSession` / `importFromJsonl`
- [x] 设计 CLI 顶层命令：`/new-group`、`/groups`、`/switch-group`、`/rename-group`
- [x] 设计 `octo-group-extension`，通过 Pi extension 注册 group 命令
- [x] 使用 inline `extensionFactories` 注入 `octo-group-extension`
- [x] 新增 `octo cli` 入口，并让当前 group 绑定一个真实 Pi `AgentSessionRuntime`
- [x] 确认 CLI `/clear` 是否直接映射到 Pi `newSession()` 语义
- [x] 设计 `resolveTargetSession()` 策略：优先 `session_ref`，其次最近 session，最后 fresh session
- [x] 为 `switchSession` / `importFromJsonl` 加 group 边界守卫，防止跳出 Octo registry
- [x] 设计 CLI state 持久化：最近使用 group 的本地状态文件
- [x] 设计 group picker UI，参考 Pi `SessionSelectorComponent`，但不直接复用其 session 文案
- [x] 设计 CLI 侧 `MessageSender`，确保现有 `createGroupToolDefs()` 可在 Pi-native runtime 中复用
- [x] 设计 `FeishuGroupAdapter`，让飞书消息进入统一的 group runtime host
- [x] 设计 Feishu 出站事件适配：文本、图片、文件、流式分片与 turn 完成边界
- [x] 设计 Feishu 侧 runtime 复用策略：同 group 的并发、续接与 `session_ref` 更新
- [x] 补充测试方案：group 创建、group 切换、CLI group 与飞书 group 隔离、group 内 session clear
