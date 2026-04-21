# 删除 `src` 死代码与 legacy 模块重构方案

## 1. 问题定义

当前 `src` 目录里同时存在两类死代码：

1. **编译器可直接证明未使用的声明**
   - 未使用 import
   - 未使用 type import
   - 未使用私有方法
2. **已经脱离真实运行入口的 legacy 模块**
   - 从当前三个入口 `src/index.ts`、`src/cli.ts`、`src/desktop/main.ts` 出发不可达
   - 仅剩测试文件或历史文档仍在引用

这会带来几个实际问题：

- 阅读成本高，代码里混有“当前主路径”和“历史遗留路径”
- 测试命名与脚本仍在暗示旧运行时链路还有效
- 后续继续重构时，容易把 legacy 模块误当成生产路径的一部分

本次目标是把 `src` 里的死代码从“看起来还活着”变成“明确删除或明确保留”，优先删除已经不参与当前运行链路的代码。

## 2. 对现有项目的影响

### 2.1 当前确认的真实入口

- `src/index.ts`
- `src/cli.ts`
- `src/desktop/main.ts`

我已基于这三个入口做过一次静态可达性扫描。当前不可达的 `src` 文件有：

- `src/group-queue.ts`
- `src/kernel/session-file.ts`
- `src/providers/index.ts`
- `src/providers/pi.ts`
- `src/runtime/model-logger.ts`
- `src/runtime/openai-transform.ts`

其中又可以继续分成两组：

### 2.2 可直接删除、几乎无外部影响

- `src/kernel/session-file.ts`
  - 仓库内没有任何源码或测试引用
- `src/runtime/model-logger.ts`
  - 仓库内没有任何源码或测试引用

### 2.3 只剩测试脚本/历史文档引用的 legacy 模块

- `src/group-queue.ts`
  - 当前只被 `tests/group-queue.test.ts`、`tests/group-memory.test.ts` 引用
- `src/providers/pi.ts`
  - 当前只被 `tests/providers.test.ts` 引用
- `src/providers/index.ts`
  - 当前没有生产引用；其存在意义主要是 re-export `PiProvider`
- `src/runtime/openai-transform.ts`
  - 当前只被 `tests/runtime.test.ts` 引用

### 2.4 编译器已确认的未使用声明

在仅针对当前入口链路运行更严格的 TypeScript 检查后，已确认以下未使用项：

- `src/cli.ts`
  - 未使用 import：`getWorkspaceDirectory`
- `src/desktop/admin-api.ts`
  - 未使用 type import：`DesktopAdminDirectoryListingDto`
  - 未使用 type import：`DesktopAdminFileContentDto`
- `src/kernel/group-runtime-manager.ts`
  - 未使用私有方法：`getWorkspaceForChat()`
- `src/kernel/renderable-message.ts`
  - 未使用 type import：`SessionMessageEntry`
- `src/runtime/feishu-group-adapter.ts`
  - 未使用 import：`getChatById`

## 3. 实现方案

本次实现分四阶段，避免把“安全清理”“删除 legacy 子系统”“文档收口”“测试体系收敛”混成一次大爆炸修改。

### 3.1 第一阶段：安全死代码清理

这一阶段只处理不会改变系统架构边界、且基本不涉及测试语义迁移的内容。

修改范围：

- `src/cli.ts`
- `src/desktop/admin-api.ts`
- `src/kernel/group-runtime-manager.ts`
- `src/kernel/renderable-message.ts`
- `src/runtime/feishu-group-adapter.ts`
- 删除 `src/kernel/session-file.ts`
- 删除 `src/runtime/model-logger.ts`

处理方式：

```ts
// 例：删除未使用私有方法
private getWorkspaceForChat(chat: ChatRow): WorkspaceRow {
  ...
}
```

```ts
// 例：删除未使用 import / type import
import { getWorkspaceDirectory } from "./group-workspace";
import type { DesktopAdminDirectoryListingDto } from "./admin-types";
```

架构决策：

- “仓库里完全没有引用”的文件直接删除，不为潜在未来用途保留空壳
- “入口链路内已确认未使用”的声明直接删除，不做保守保留

### 3.2 第二阶段：删除 legacy 运行时模块

这一阶段处理已经不在当前运行入口上的旧链路代码。

拟删除文件：

- `src/group-queue.ts`
- `src/providers/pi.ts`
- `src/providers/index.ts`
- `src/runtime/openai-transform.ts`

连带修改：

- 删除或重写依赖这些模块的测试
  - `tests/group-queue.test.ts`
  - `tests/providers.test.ts`
  - `tests/runtime.test.ts` 中对 `openai-transform` 的测试段
  - `tests/group-memory.test.ts` 中依赖 `GroupQueue` 的测试段
- 更新 `package.json`
  - 移除或改写 `test:providers`
  - 移除或改写 `test:pi`

实现原则：

- 以“当前真实入口是否可达”作为保留标准
- 测试文件不再作为保留 dead runtime 模块的理由
- 只删除 `src` 与直接依赖它的测试/脚本，不在本轮清理历史 specs/docs

对应关系大致如下：

```ts
// 旧链路
GroupQueue -> PiProvider -> openai-transform

// 当前主链路
FeishuGroupAdapter / GroupRuntimeManager / PiGroupRuntimeFactory
```

这意味着第二阶段不是简单“删文件”，而是显式承认旧 runtime 路径已退场，并同步收敛测试与脚本。

### 3.3 第三阶段：活文档与命名收口

第二阶段完成后，生产代码已经删除：

- `src/group-queue.ts`
- `src/providers/pi.ts`
- `src/providers/index.ts`
- `src/runtime/openai-transform.ts`

但当前对外文档仍有一批“看起来像现状、实际上已过期”的描述，主要问题有：

1. README 和项目总览仍把当前运行时描述成 `PiProvider` 驱动
2. 架构图仍画出 `PiProvider` 节点，而不是当前真实边界
3. 某些段落仍把 `group` 作为当前主业务概念，而不是兼容语义
4. 某些说明仍把 `GroupQueue` 当成当前可用链路，而不是已删除的 legacy 模块

这一阶段只清理“面向当前读者的活文档”，不批量改写历史设计文档。

建议修改范围：

- `README.md`
- `docs/octo.md`
- `docs/multi-agent-provider.md`

明确不在本阶段改写的内容：

- 历史 `specs/*.md`
  - 原因：这些文件记录的是当时的设计和演进过程，保留旧术语是可接受的
- 已经失效但未纳入当前主链路的旧测试文件
  - 这类问题更适合单独做测试体系收敛，而不是混在文档收口里

文档改写原则：

- 用“Pi runtime / Pi session helpers / Pi MCP extension bridge”描述当前能力，而不是继续引用已删除的 `PiProvider`
- 用 `Workspace / Chat / Run` 描述当前主模型；出现 `group` 时明确标注为 legacy/兼容语义
- 架构图只保留当前真实主路径：

```text
Channel / Router / Sidecar API
  → Workspace / Chat binding
    → GroupRuntimeManager / FeishuGroupAdapter
      → PiGroupRuntimeFactory / Pi session helpers / Pi MCP extensions
```

- 若某份文档本质上已是历史说明，应改成“历史背景”或“兼容说明”，而不是继续伪装成当前架构说明

### 3.4 第四阶段：清理无效测试代码并收敛失败套件

在前三阶段完成后，`src` 主链路已经收口，但当前 `tests/*.test.ts` 仍残留大量旧 group 时代测试。完整跑一遍后，失败集中在以下三类：

#### A. 直接绑定已删除模块或旧导出的死测试

这些测试已经没有真实被测对象，继续保留只会制造噪音：

- `tests/group-service.test.ts`
  - 依赖已删除的 `src/group-service.ts`
- `tests/group-runtime-manager.test.ts`
  - 依赖 `GroupService`、`registerGroup`、旧 `GroupRuntimeEvent`
- `tests/octo-cli-runtime-host.test.ts`
  - 依赖 `GroupService`、旧 `createGroupRuntime` / `currentGroup`
- `tests/octo-group-extension.test.ts`
  - 依赖 `GroupService` 和旧命令名（`new-group` / `switch-group` / `rename-group`）

这类测试建议直接删除，而不是继续迁就旧接口。

#### B. 功能仍然存在，但测试接口已经漂移

这些测试覆盖的功能仍有价值，但断言和调用方式停留在旧语义，应该改写而不是删除：

- `tests/cli-state-store.test.ts`
  - 仍在读不存在的 `getCurrentGroupFolder()`
- `tests/channel-manager.test.ts`
  - 仍依赖旧的 `registerGroup` helper
- `tests/desktop-api.test.ts`
  - 仍使用旧 `GroupRuntime*` 类型、旧 `groups/:folder` 路由和 `createCliGroup`
- `tests/desktop-admin-api.test.ts`
  - 仍使用 group admin 路由、旧 db helper、旧 group memory 语义
- `tests/desktop-admin-files.test.ts`
  - 仍使用 `*Group*` 文件 helper 名称，而当前实现已切到 `*Workspace*`
- `tests/desktop-server.test.ts`
  - 仍请求 `/api/desktop/groups*` 与 `/api/desktop/admin/groups*`，而当前 server 已切到 `/workspaces*`

#### C. 当前已经通过、且仍覆盖有效行为的测试

这类测试本轮不动，避免把“测试清理”扩成“全量重写”：

- `tests/router.test.ts`
- `tests/turn-request-integration.test.ts`
- `tests/feishu-group-adapter.test.ts`
- `tests/desktop-main.test.ts`
- `tests/cli-bootstrap.test.ts`
- `tests/providers.test.ts`
- `tests/runtime.test.ts`
- `tests/pi-group-runtime-factory.test.ts`
- 以及其他当前通过且不依赖旧 group domain 的测试

#### 第四阶段实施策略

本阶段建议分两步：

1. **删除无被测对象的死测试**
   - 直接删除 A 类文件
2. **改写仍有价值的漂移测试**
   - 只改写 B 类文件，改到当前 `Workspace / Chat / RuntimeSnapshot` 语义
   - 不为了“保住旧断言”而在生产代码里回加兼容 API

具体修改方向：

- `tests/cli-state-store.test.ts`
  - 改成只断言 `getCurrentWorkspaceFolder()` 与 `getCurrentChatId()`
- `tests/channel-manager.test.ts`
  - 用当前 `WorkspaceService` / chat binding 构造可发送目标
- `tests/desktop-api.test.ts`
  - 使用当前 `RuntimeSnapshotController`
  - 路由改成 `workspaces/:workspaceId/chats/:chatId/*`
  - 类型改成 `RuntimeSnapshot` / `RuntimeSummary` / `CreateCliWorkspaceResult`
- `tests/desktop-admin-api.test.ts`
  - 改成 workspace admin API
  - memory 改成 `workspace_memories`
- `tests/desktop-admin-files.test.ts`
  - 使用 `listWorkspaceDirectory` / `readWorkspaceTextFile` / `writeWorkspaceTextFile` / `createWorkspaceDirectory`
- `tests/desktop-server.test.ts`
  - 路由对齐 `startDesktopServer()` 当前注册表

本阶段的目标不是“提高覆盖率”，而是：

- 删除已经失效的测试代码
- 让剩余测试语义与当前代码一致
- 尽量把 `bun test tests/*.test.ts` 收敛到可通过状态

### 3.5 验证方案

第一阶段验证：

- 运行针对当前入口链路的 TypeScript 检查，确认未使用声明已消失
- 运行与改动最相关的测试

建议命令：

```bash
bunx tsc --noEmit --noUnusedLocals --noUnusedParameters --moduleResolution bundler --module preserve --target ESNext --lib ESNext --allowJs --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --noFallthroughCasesInSwitch --noUncheckedIndexedAccess --noImplicitOverride --jsx react-jsx src/index.ts src/cli.ts src/desktop/main.ts
```

```bash
bun test tests/desktop-main.test.ts tests/desktop-admin-api.test.ts tests/feishu-group-adapter.test.ts tests/octo-cli-runtime-host.test.ts tests/group-runtime-manager.test.ts
```

第二阶段验证：

- 删除 legacy 文件后，测试脚本中不再引用这些模块
- `package.json` 中不再保留已无意义的 legacy 测试入口
- 运行一轮与新主链路一致的核心测试集

第三阶段验证：

- `README.md`、`docs/octo.md`、`docs/multi-agent-provider.md` 中不再把 `PiProvider`、`GroupQueue` 描述为当前生产主路径
- 活文档中的架构图与当前源码入口一致
- 历史 `specs/*.md` 保持原样，不做误导性“重写历史”

第四阶段验证：

- 删除的测试文件不再被 `bun test tests/*.test.ts` 引用
- 改写后的测试只依赖当前 `src` 导出与当前 HTTP 路由
- 运行 `bun test tests/*.test.ts`
- 若仍有失败，失败原因必须来自当前真实代码缺陷，而不是 legacy 测试残留

## 4. Todo List

- [x] 新增并确认本规格
- [x] 第一阶段：删除 `src` 中已确认的未使用 import / type import / 私有方法
- [x] 第一阶段：删除 `src/kernel/session-file.ts`
- [x] 第一阶段：删除 `src/runtime/model-logger.ts`
- [x] 第一阶段：运行入口链路 TypeScript 检查
- [x] 第一阶段：运行与改动相关的核心测试
- [x] 第二阶段：删除 `src/group-queue.ts`
- [x] 第二阶段：删除 `src/providers/pi.ts`
- [x] 第二阶段：删除 `src/providers/index.ts`
- [x] 第二阶段：删除 `src/runtime/openai-transform.ts`
- [x] 第二阶段：清理依赖 legacy 模块的测试文件与测试脚本
- [x] 第二阶段：运行清理后的核心测试并记录结果
- [x] 第三阶段：更新 README，去掉对 `PiProvider` / `GroupQueue` 作为当前主路径的描述
- [x] 第三阶段：更新 `docs/octo.md`，对齐当前真实运行时边界
- [x] 第三阶段：更新 `docs/multi-agent-provider.md`，去掉对已删除模块的现状式描述
- [x] 第三阶段：验证活文档中的架构图和术语与当前源码一致
- [x] 第四阶段：删除直接绑定已删除模块的死测试文件
- [x] 第四阶段：改写仍覆盖活功能但接口已漂移的测试文件
- [x] 第四阶段：运行 `bun test tests/*.test.ts` 并记录剩余失败项

## 5. 需要你确认的范围

默认建议是：

1. 先执行第一阶段，确保把“确定无争议”的死代码先删掉
2. 再执行第二阶段，把只剩测试/历史文档引用的 legacy 模块一并清掉
3. 最后只收口活文档，不批量改写历史 specs
4. 若继续清理测试，只删除“没有被测对象”的死测试，并把仍有价值的测试改到当前语义

如果你希望降低变更面，也可以只批准第一阶段。
