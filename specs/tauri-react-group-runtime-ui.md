# Tauri React Group Runtime UI 方案

## 问题描述

当前项目已经有两类入口：

1. CLI 入口
   - 本地交互式使用
   - 基于 Pi-native runtime
   - 已经具备 group 切换、session 恢复、working directory 绑定等语义
2. 飞书入口
   - 面向群消息驱动
   - 通过现有 router / queue / provider 路径驱动 Pi-native runtime

但 CLI 作为终端 UI，虽然功能上可用，仍然不适合以下场景：

1. 频繁查看和切换 group
2. 可视化展示 streaming / thinking / tool 执行
3. 作为本地桌面应用长期使用

本次目标不是再做一套新的浏览器 runtime，而是新增一个**桌面端展示层**：

1. 新增一个独立的 Tauri + React 项目
2. 桌面端只作为新的入口和展示层
3. 底层继续使用 Octo 现有的 Pi-native group runtime
4. CLI、Tauri、Feishu 最终都走同一个 group session 管理内核
5. 不修改 `src/admin`
6. 不修改 `@pi-mono`
7. `pi-web-ui` 只作为设计参考，不直接 copy/import 其高层组件

这意味着本次的核心原则是：

```text
CLI Terminal UI
Tauri React UI
Feishu Message Adapter
  -> 同一个 GroupRuntimeManager
     -> group 绑定的 cwd / profile / memory / session_ref
     -> 同一个 Pi-native runtime
```

## 对现有项目的影响

本次会影响以下模块：

1. 共享 group runtime 管理层
   - 新增 `src/kernel/` 或等价目录
   - 抽出 `GroupRuntimeManager`
2. CLI 入口
   - `src/cli.ts`
   - `src/cli/octo-cli-runtime-host.ts`
   - 需要接入新的共享 manager，而不是独占一套 runtime 组装逻辑
3. 飞书 / 队列入口
   - `src/group-queue.ts`
   - 需要评估如何逐步接入共享 manager
4. 运行时封装
   - `src/runtime/pi-group-runtime-factory.ts`
   - 可能新增通用 session host 或 adapter
5. 新桌面端项目
   - 新增独立 Tauri + React 工程目录
   - 前端 React UI
   - Tauri sidecar 启动配置
6. 桌面 sidecar API
   - 新增本地 HTTP / SSE 接口，仅供 Tauri 应用访问
7. 测试
   - 新增 manager 层测试
   - 新增 desktop API 测试
   - 视情况调整 CLI 测试

明确不影响：

1. `src/admin/*`
2. `pi-mono/*`
3. `@mariozechner/pi-web-ui` 包源码

## 实现方案

### 一、目标边界

本次不是实现“浏览器自己跑 Agent”的 Web 应用，而是实现：

1. 一个由 Tauri 托管的 macOS 桌面应用
2. 一个由 Tauri 自己启动并托管的 app 专用 Octo sidecar 进程
3. 一个只负责展示和交互的 React 前端

因此必须明确排除以下方案：

1. 直接使用 `pi-web-ui` 的 `ChatPanel`
2. 直接使用 `pi-web-ui` 的 `AgentInterface`
3. 在前端创建浏览器端 `Agent`
4. 在前端保存 provider key / model / session 状态
5. 在浏览器环境直接连接模型 API

原因是这些模式都与“唯一底层 runtime 在 Octo 本地进程里”冲突。

### 二、为什么 `pi-web-ui` 只能参考，不能直接复用高层组件

调研结论如下：

1. `pi-web-ui` 的高层组件默认假设前端自己持有 `Agent`
2. 高层组件会直接调用：
   - `session.prompt()`
   - `session.abort()`
   - `session.state.model = ...`
   - `session.state.thinkingLevel = ...`
3. 高层组件还会默认从浏览器端存储读取 API key
4. 这套假设适合“前端自己是 runtime”，不适合“前端只是桌面展示层”

因此本次对 `pi-web-ui` 的原则是：

1. 不 copy `ChatPanel`
2. 不 copy `AgentInterface`
3. 不直接 import 其高层控制逻辑
4. 只参考其消息渲染结构、streaming 展示模式、tool block 展示思路
5. 在 React 项目里实现自己的 UI 组件

### 三、顶层架构

推荐架构如下：

```text
Tauri App
  ├─ React UI
  └─ managed sidecar process
       └─ Octo Desktop Host
            ├─ local HTTP API
            ├─ SSE event stream
            └─ GroupRuntimeManager
                 ├─ group -> cwd/profile/memory/session_ref
                 ├─ Pi session create/resume
                 ├─ prompt/follow_up/steer/abort/newSession
                 └─ runtime event fan-out
```

关键点：

1. Tauri 只负责桌面宿主和 sidecar 生命周期
2. React 不直接接触 Pi runtime
3. sidecar 持有唯一的 group runtime 管理内核
4. 桌面端与 CLI 只是展示层不同

### 四、为什么选择“由 Tauri 自己启动并托管 sidecar”

本次明确选用：

1. **Tauri 自己启动并托管一个 app 专用的 Octo sidecar 进程**

不选“连到一个用户手动启动的常驻 Octo 进程”。

原因：

1. 生命周期最清晰
   - 打开 app -> sidecar 启动
   - 关闭 app -> sidecar 回收
2. 版本一致性最好
   - UI 和 sidecar 同一打包版本
3. 用户使用最简单
   - 不需要先手动执行 `bun src/xxx.ts`
4. 最接近“桌面版 CLI”
   - 只是把终端换成窗口

### 五、共享内核：`GroupRuntimeManager`

这里不建议继续使用 “controller” 这个命名，避免和前端状态管理概念混淆。
推荐命名：

1. `GroupRuntimeManager`

建议目录：

1. `src/kernel/`

例如：

1. `src/kernel/group-runtime-manager.ts`
2. `src/kernel/types.ts`
3. `src/kernel/runtime-session-host.ts`

这个 manager 不是新的 runtime，而是对现有运行时组装逻辑的统一收口层。

它负责：

1. 根据 `groupFolder` 解析：
   - group 元数据
   - working directory
   - profile
   - persisted `session_ref`
2. 懒创建或恢复当前 group 的活跃 Pi session
3. 对外暴露统一操作：
   - `prompt`
   - `followUp`
   - `steer`
   - `abort`
   - `newSession`
   - `switchGroup`
   - `getSnapshot`
   - `subscribe`
4. 统一处理 session replacement 后的 `session_ref` 持久化
5. 向不同入口广播统一事件

它不负责：

1. 终端渲染
2. React 渲染
3. 飞书消息发送样式
4. Tauri 窗口逻辑

可以把它理解成：

```text
GroupRuntimeManager = Octo 共享 group 会话控制层
```

#### 当前第一阶段实际落地

第一阶段已经在代码中落地了一个可工作的 `GroupRuntimeManager`，位置为：

1. `src/kernel/group-runtime-manager.ts`
2. `src/kernel/types.ts`
3. `src/kernel/renderable-message.ts`

当前实现和最初设计相比，有两个需要明确的点：

1. manager 目前不只是“切 session”
   - 它同时负责维护当前 group 的 snapshot
   - 负责把 Pi 的底层 `AgentSessionEvent` 转成 Octo 自己的 `GroupRuntimeEvent`
2. 这层事件桥接不是为了 CLI 本身
   - 纯 CLI 模式下，终端 UI 主要由 Pi 自己的 `InteractiveMode` 处理
   - 但 desktop 需要通过 sidecar 的 HTTP + SSE 获取可渲染状态和增量事件
   - 因此 manager 必须接住 `message_start` / `message_update` / `tool_execution_*` / `queue_update` 等事件

可以把当前实现理解成：

```text
Pi AgentSessionEvent
  -> GroupRuntimeManager.handleSessionEvent()
     -> GroupRuntimeEvent
        -> desktop SSE
        -> snapshot 重建
        -> session_ref 持久化
```

这意味着：

1. CLI 现在已经复用同一个 manager 做 group/session 管理
2. 但 CLI 当前并不直接消费 `GroupRuntimeEvent`
3. desktop 才是这套事件桥接的主要消费者
4. 后续如果觉得职责过重，可以再拆出单独的 event bridge，但当前阶段先不拆，优先保证共享内核成立

#### 建议接口

```ts
export interface GroupRuntimeManager {
  listGroups(): GroupRuntimeSummary[];
  getSnapshot(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  prompt(
    groupFolder: string,
    input: { text: string; mode?: "prompt" | "follow_up" | "steer" },
  ): Promise<GroupRuntimeSnapshot>;
  abort(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  newSession(groupFolder: string): Promise<GroupRuntimeSnapshot>;
  subscribe(
    groupFolder: string,
    listener: (event: GroupRuntimeEvent) => void,
  ): () => void;
}
```

#### 建议事件类型

```ts
export type GroupRuntimeEvent =
  | { type: "snapshot"; snapshot: GroupRuntimeSnapshot }
  | { type: "message_start"; groupFolder: string; message: RuntimeRenderableMessage }
  | {
      type: "message_delta";
      groupFolder: string;
      message: RuntimeRenderableMessage;
      delta: RuntimeMessageDelta;
    }
  | { type: "message_end"; groupFolder: string; message: RuntimeRenderableMessage }
  | {
      type: "tool_start";
      groupFolder: string;
      toolName: string;
      toolCallId: string;
      argsText: string;
    }
  | {
      type: "tool_update";
      groupFolder: string;
      toolCallId: string;
      partialResultText: string;
    }
  | {
      type: "tool_end";
      groupFolder: string;
      toolCallId: string;
      isError: boolean;
      resultText: string;
    }
  | {
      type: "queue_update";
      groupFolder: string;
      steering: string[];
      followUp: string[];
    }
  | { type: "agent_end"; groupFolder: string }
  | { type: "error"; groupFolder: string; message: string };
```

### 六、`GroupRuntimeManager` 与现有代码的关系

推荐把它建立在当前 CLI 路径所依赖的 runtime host 之上，而不是直接基于老的 provider 抽象。

原因：

1. CLI 路径已经更接近“活的 session 控制”
2. 它已经天然支持：
   - group 级 cwd
   - session replacement
   - session file 持久化
3. Tauri 想做到“和 CLI 一样，只是展示层不同”，应该对齐这条语义

重点参考：

1. `src/runtime/pi-group-runtime-factory.ts`
2. `src/cli/octo-cli-runtime-host.ts`
3. `src/cli.ts`

需要做的事情不是复制 CLI，而是把 CLI 使用的核心会话控制能力抽成公共层。

#### 推荐演进方式

Phase 1：

1. 抽出通用 session host
2. 让 CLI 接到 `GroupRuntimeManager`
3. Tauri sidecar 也接到 `GroupRuntimeManager`

Phase 2：

1. 评估 `group-queue` 是否改为逐步复用这层 manager 的子集
2. 不要求首期就完全重写 Feishu 路径

也就是说，首期重点是：

1. CLI 与 Tauri 真正共用同一套 group session 管理能力
2. Feishu 保持底层兼容，不阻塞桌面端落地

#### 当前 Phase 1 实际完成情况

已完成：

1. `GroupRuntimeManager` 已落地
2. CLI 已改为通过 manager 管理 group session
3. desktop sidecar API 已落地 HTTP + SSE 路由与测试
4. snapshot / renderable DTO / event DTO 已落地
5. desktop sidecar 启动入口已落地到 `src/desktop/main.ts`
6. 最小 `desktop/` Tauri + React 工程已落地
7. Tauri 已负责为桌面窗口启动 sidecar、注入 base URL、在退出时回收子进程
8. React 桌面 UI 已具备 group 列表、创建 CLI group、transcript、输入区、停止、新会话

未完成：

1. Feishu 尚未切到 manager
2. 桌面端仍缺少真实 Tauri 手工验证
3. 打包期 sidecar 资源组织仍需后续收敛

因此当前代码状态更准确地说是：

```text
共享内核 + desktop API + Tauri 宿主 + React UI 已完成首期可用版本
后续重点转向桌面端交互补完与打包期 sidecar 分发收敛
```

### 七、桌面 sidecar API

Tauri 不直接碰 DB 或 runtime，而是通过本地 sidecar API。

建议 sidecar 提供：

1. `GET /api/desktop/groups`
2. `GET /api/desktop/groups/:folder/snapshot`
3. `POST /api/desktop/groups/:folder/prompt`
4. `POST /api/desktop/groups/:folder/abort`
5. `POST /api/desktop/groups/:folder/session/new`
6. `GET /api/desktop/groups/:folder/events`
7. `POST /api/desktop/groups/cli`

其中：

1. snapshot 用于首次加载
2. SSE 用于 streaming / tool / thinking 增量更新
3. `POST /api/desktop/groups/cli` 用于创建新的本地 CLI group

#### 当前已实现的 sidecar API 边界

当前仓库已经新增：

1. `src/desktop/api.ts`
2. `src/desktop/server.ts`

这代表以下能力已经到位：

1. 统一的 desktop API 路由定义
2. 基于 `GroupRuntimeManager` 的 snapshot 查询
3. 基于 `GroupRuntimeManager.subscribe()` 的 SSE 增量推送
4. 通过 `GroupService.createCliGroup()` 创建新的 desktop CLI group

但以下内容仍未到位：

1. Tauri 对 sidecar 生命周期的托管逻辑
2. sidecar 与 Tauri 打包时的最终资源组织方式

#### 当前已实现的 sidecar 启动入口

当前仓库已经新增：

1. `src/desktop/main.ts`

这代表以下能力已经到位：

1. `rootDir` / 数据库路径 / hostname / port 的启动参数解析
2. sidecar 启动时自动初始化 DB、`GroupService`、`ChannelManager`、`GroupRuntimeManager`
3. 复用现有 outbound Feishu channel 注册逻辑
4. 启动本地 desktop HTTP/SSE server
5. 在 `SIGINT` / `SIGTERM` 下优雅停止 server、manager、channelManager 与 DB

#### 当前 desktop 工程实际落地

当前仓库已经新增：

1. `desktop/package.json`
2. `desktop/src/`
3. `desktop/src-tauri/`

当前实现采用：

1. Bun 直接构建 React 前端，不额外引入 Vite
2. Tauri 在启动时拉起 `bun run desktop:sidecar`
3. Tauri 通过初始化脚本把 sidecar base URL 注入给前端
4. React 前端通过现有 desktop HTTP + SSE API 拉取 snapshot 并合并运行时事件

这一版的边界也需要明确：

1. 重点先保证本地开发与桌面壳层联通
2. 打包时 sidecar 不再依赖 Bun 的最终形态，留到后续阶段收敛

#### desktop 新建 group 补充方案

当前仓库已经有可复用的底层能力：

1. `GroupService.createCliGroup()`

所以 desktop 这次不需要设计新的 group 创建模型，只需要把现有 CLI group 创建能力透出到 sidecar 和前端。

本次建议边界明确为：

1. 只支持创建新的 **CLI group**
2. 不支持在 desktop 中直接创建 Feishu group
3. 创建完成后自动切换到新 group
4. 创建后立即拉取 snapshot 并接入 SSE

建议新增接口：

```ts
POST /api/desktop/groups/cli
{
  name?: string;
}
```

返回：

```ts
{
  group: GroupRuntimeSummary;
  snapshot: GroupRuntimeSnapshot;
}
```

实现上建议：

1. `src/desktop/api.ts`
   - 新增 `createCliGroup(req)`
   - 校验 `name` 可选，空字符串视为未传
2. `src/desktop/main.ts`
   - 把 `GroupService` 传入 desktop API router，供其创建 group
3. `src/desktop/server.ts`
   - 新增 `POST /api/desktop/groups/cli`
4. `desktop/src/lib/desktop-client.ts`
   - 新增 `createCliGroup(input)`
5. `desktop/src/App.tsx`
   - 新增创建 group 动作
   - 创建成功后把新 group 写入 `groups`
   - 自动切换 `activeGroupFolder`
6. `desktop/src/components/group-sidebar.tsx`
   - 新增 “新建 Group” 按钮
   - 首期使用 `prompt()` 获取名字，不先引入复杂弹窗

#### desktop 创建 group 的交互建议

首期交互保持最小：

1. 左侧 sidebar 顶部新增 `新建 Group` 按钮
2. 点击后弹出浏览器原生 `prompt`
3. 用户可输入 group 名称，也可留空
4. 创建成功后：
   - 列表插入新 group
   - 自动选中新 group
   - 右侧展示空 transcript
5. 创建失败后：
   - 在状态栏显示错误文字

这里不建议首期就做复杂 modal，原因是：

1. 目标只是先把创建链路打通
2. `prompt()` 足够验证产品语义
3. 后续如果 desktop 继续演进，再替换成正式对话框也很容易

#### DTO 建议

```ts
export interface GroupRuntimeSnapshot {
  groupFolder: string;
  groupName: string;
  profileKey: string;
  sessionRef: string | null;
  isStreaming: boolean;
  pendingFollowUp: string[];
  pendingSteering: string[];
  messages: RuntimeRenderableMessage[];
}

export interface RuntimeRenderableMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom";
  timestamp: number | string;
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | {
        type: "tool_call";
        toolCallId: string;
        toolName: string;
        argsText: string;
      }
    | {
        type: "tool_result";
        toolCallId: string;
        toolName: string;
        text: string;
        isError: boolean;
      }
    | {
        type: "bash";
        command: string;
        output: string;
        exitCode?: number;
        cancelled: boolean;
      }
    | { type: "custom"; customType: string; text: string }
  >;
}
```

### 八、React + Tauri 前端设计

前端目录建议新增独立工程，例如：

1. `desktop/`
2. `desktop/src/`
3. `desktop/src-tauri/`

或同等结构。

要求：

1. React 前端只在 Tauri 中使用
2. 不支持普通浏览器环境作为正式运行形态
3. 不在前端存储模型密钥、会话或 provider 配置

#### UI 目标

要做到“像 CLI 一样，只是展示层不同”，React UI 至少应支持：

1. 左侧 group 列表
2. 新建 CLI group
3. 当前 group transcript
4. streaming assistant 文本
5. thinking 块
6. tool 执行块
7. 新会话
8. 停止生成
9. 切换 group 后自动展示对应 session

#### 下一阶段建议目录

建议下一阶段新增：

1. `desktop/package.json`
2. `desktop/src/main.tsx`
3. `desktop/src/App.tsx`
4. `desktop/src/lib/desktop-client.ts`
5. `desktop/src/components/group-sidebar.tsx`
6. `desktop/src/components/transcript-view.tsx`
7. `desktop/src/components/composer.tsx`
8. `desktop/src-tauri/src/main.rs`

这样职责会比较清晰：

1. `desktop/src/lib/desktop-client.ts`
   - 负责 HTTP 请求
   - 负责 EventSource / SSE 订阅
   - 不做 UI 状态管理
2. `desktop/src/App.tsx`
   - 持有当前 group、snapshot、streaming 状态
   - 负责把 SSE 增量合并到前端状态
3. `desktop/src-tauri/src/main.rs`
   - 负责启动/回收 sidecar
   - 把 base URL 注入前端

#### React 首期最小状态模型

建议前端只维护：

1. `groups: GroupRuntimeSummary[]`
2. `activeGroupFolder: string | null`
3. `snapshotsByGroup: Record<string, GroupRuntimeSnapshot>`
4. `connectionState: "idle" | "connecting" | "open" | "error"`
5. `isCreatingGroup: boolean`

避免前端自己再维护另一套“会话真相”：

1. streaming 真相来自 SSE
2. 初始真相来自 snapshot
3. 新会话 / abort / prompt 后，再以 sidecar 返回值或后续 snapshot 对齐

#### 与 `pi-web-ui` 的关系

React 版 UI 不直接复用 `pi-web-ui` 组件，而是参考：

1. 消息列表分层方式
2. streaming message 容器思路
3. tool result 嵌入 assistant 展示方式
4. 输入区的基础交互语义

#### 不支持的能力

首期不支持：

1. 浏览器内模型直连
2. 前端本地 session store
3. 前端保存 provider key
4. 纯 Web 发布
5. 附件上传
6. 多窗口并发共享一个前端本地状态

### 九、Tauri 与 sidecar 的生命周期

建议：

1. Tauri 启动时拉起 sidecar
2. sidecar 监听本地回环地址，例如 `127.0.0.1`
3. 端口可由 sidecar 启动时动态分配，并通过 Tauri 注入给前端
4. Tauri 退出时尝试优雅关闭 sidecar

必要约束：

1. sidecar 仅供本地桌面 app 访问
2. 默认不暴露为通用 LAN 服务

#### 下一阶段具体落地顺序

建议按下面顺序施工：

1. 先补 `src/desktop/main.ts`
   - 负责初始化 DB / GroupService / ChannelManager / GroupRuntimeManager
   - 调用 `startDesktopServer()`
2. 再新增 `desktop/` React + Tauri 工程
3. 先让 Tauri 成功启动 sidecar，并把端口注入给前端
4. React 先只做 group list + snapshot 拉取 + SSE transcript
5. 最后补 prompt / abort / newSession 的交互闭环

### 十、测试策略

测试至少包括：

1. `GroupRuntimeManager` 单元测试
   - 按 group 恢复 session
   - `prompt` / `abort` / `newSession`
   - `session_ref` 持久化
2. CLI 回归测试
   - 改接 manager 后原有行为不退化
3. desktop API 测试
   - group 列表
   - snapshot
   - SSE 事件流
   - 创建 CLI group
4. desktop 前端状态测试
   - 创建 group 后自动选中并写入 snapshot
5. 手工验证
   - 启动桌面 app
   - 新建 group
   - 切换 group
   - 发消息
   - streaming
   - 停止
   - 新会话
   - 重启 app 后恢复已有 session

## 关键架构决策

### 决策 1：桌面端只做展示层，不持有浏览器端 Agent

原因：

1. 必须保证唯一底层 runtime
2. 避免前端自己跑模型
3. 避免 API key 和 session 状态漂移到前端

### 决策 2：`pi-web-ui` 只参考，不直接复用高层组件

原因：

1. 高层组件假设浏览器自己持有 Agent
2. 与本项目架构冲突
3. React 项目直接套 Lit 高层组件不合适

### 决策 3：Tauri 自己托管 sidecar

原因：

1. 生命周期和分发最简单
2. 与桌面应用产品形态一致

### 决策 4：共享内核以 `GroupRuntimeManager` 为边界

原因：

1. 避免 CLI / Tauri / Feishu 各自长出第三套 runtime 组装逻辑
2. 让“只是展示层不同”在工程上真正成立

## Todo List

第一阶段到这里正式收尾。

说明：

1. “通用 session host” 没有单独落成新的独立模块文件
2. 但 CLI 与 desktop 已经通过 `GroupRuntimeManager` + `createPiGroupRuntime()` 复用了同一套 group/session 管理语义
3. 桌面端已经完成真实手工验证，并根据验证结果修正了创建 group、日志、布局与长文本溢出等交互细节
4. 因此本 spec 以“首期可用版本完成”为准收口

- [x] 确认桌面项目目录结构与构建方式
- [x] 新增 `src/kernel/` 目录并实现 `GroupRuntimeManager` 基础接口
- [x] 抽取通用 session host，使 CLI 的 runtime 管理逻辑可复用
- [x] 让 CLI 改为通过 `GroupRuntimeManager` 访问 group session
- [x] 设计并实现 desktop sidecar HTTP + SSE API
- [x] 新增 desktop sidecar 启动入口（如 `src/desktop/main.ts`）
- [x] 新增独立 Tauri + React 项目
- [x] 在 Tauri 中实现 sidecar 启动、端口注入、退出回收
- [x] 实现 React 桌面 UI：group 列表、消息区、输入区、停止、新会话
- [x] 参考 `pi-web-ui` 的消息结构与 streaming 展示方式，但不直接复用高层组件
- [x] 为 desktop 新增“创建 CLI group”入口与 sidecar API
- [x] 定义桌面端可渲染的消息 DTO 与事件 DTO
- [x] 实现 snapshot 拉取与 SSE 增量同步
- [x] 补充 `GroupRuntimeManager` 测试
- [x] 补充 desktop API 测试
- [x] 补充 CLI 回归测试
- [x] 进行桌面端手工验证并修正交互细节
