# 将 `src` 从本地 `pi-mono` 源码切换为 npm `@mariozechner/pi-coding-agent`

## 1. 问题定义

当前 `octo` 的 `src/` 与部分测试代码，直接通过相对路径引用仓库内嵌的 `pi-mono` 源码，例如：

```ts
import { InteractiveMode } from "../pi-mono/packages/coding-agent/src/index.ts";
```

这种方式的问题是：

1. `octo` 与本地 `pi-mono` 目录强绑定，运行环境必须携带完整源码树。
2. `octo` 实际依赖的是未发布源码而不是 npm 包，依赖边界不清晰。
3. 当前还有两处直接引用了 `pi` 的私有内部模块：
   - `src/cli/octo-cli-runtime-host.ts` -> `core/session-manager.ts`
   - `src/runtime/pi-group-runtime-factory.ts` -> `core/extensions/runner.ts`
4. npm 包 `@mariozechner/pi-coding-agent@0.67.6` 目前仅公开：
   - `"."`
   - `"./hooks"`

因此，本次要在**不修改 `pi-mono/` 代码**的前提下，把 `src/` 对 Pi 的依赖切换到 npm 包，并消除对私有子路径的依赖。

## 2. 对现有项目的影响

本次变更影响以下部分：

1. 依赖管理
   - 根目录 `package.json`
   - 根目录 lockfile（优先保持 Bun 体系，更新 `bun.lock`）

2. `src/` 中所有 Pi 导入
   - `src/cli.ts`
   - `src/cli/octo-cli-runtime-host.ts`
   - `src/cli/octo-group-extension.ts`
   - `src/providers/pi.ts`
   - `src/providers/pi-mcp-extension.ts`
   - `src/providers/pi-session-ref.ts`
   - `src/providers/pi-tool-adapter.ts`
   - `src/runtime/pi-group-runtime-factory.ts`

3. 测试代码
   - `tests/octo-cli-runtime-host.test.ts`
   - `tests/octo-group-extension.test.ts`
   - 若还有测试直接引用 `../pi-mono/...`，一并切换为 npm 包导入

4. 行为兼容性
   - 保持现有 runtime、session、extension 生命周期行为不变
   - 不修改 `pi-mono/` 目录下任何源码
   - 不顺带升级到 npm latest；优先锁定到与本地源码一致的 `0.67.6`

## 3. 实现方案

### 3.1 依赖与版本策略

根目录新增 npm 依赖：

```json
{
  "dependencies": {
    "@mariozechner/pi-coding-agent": "0.67.6"
  }
}
```

说明：

1. 本地 `pi-mono/packages/coding-agent/package.json` 的版本为 `0.67.6`。
2. npm 上该版本存在，但 latest 已经是 `0.67.68`。
3. 本轮迁移目标是“切换引用来源”，不是“顺带升级 Pi 版本”，因此先锁定精确版本，避免把路径迁移和上游升级耦合到一起。

### 3.2 将 `src/` 主入口导入改为 npm 包

把所有以下形式的导入：

```ts
from "../../pi-mono/packages/coding-agent/src/index.ts"
from "../pi-mono/packages/coding-agent/src/index.ts"
```

统一替换为：

```ts
from "@mariozechner/pi-coding-agent"
```

本轮仅修改 `octo` 自身代码，不改 `pi-mono`。

### 3.3 去除对 npm 不暴露的私有子路径依赖

#### A. `src/cli/octo-cli-runtime-host.ts`

当前问题：

```ts
import {
  loadEntriesFromFile,
  type SessionHeader,
} from "../../pi-mono/packages/coding-agent/src/core/session-manager.ts";
```

`loadEntriesFromFile` 不在 npm 包公开出口中，不能继续这样导入。

调整方案：

1. 改为从 npm 主入口使用公开导出：
   - `parseSessionEntries`
   - `type SessionHeader`
2. 在 `octo` 本地读取 session JSONL 文件内容，再调用 `parseSessionEntries(content)`。
3. `getSessionHeader()` 逻辑保持不变，仍然返回首个 `type === "session"` 的 header。

示意：

```ts
import { parseSessionEntries, type SessionHeader } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";

function getSessionHeader(sessionPath: string): SessionHeader | null {
  const entries = parseSessionEntries(readFileSync(sessionPath, "utf8"));
  return entries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
}
```

#### B. `src/runtime/pi-group-runtime-factory.ts`

当前问题：

```ts
import { emitSessionShutdownEvent } from "../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts";
```

`emitSessionShutdownEvent` 属于私有内部模块，不在 npm 包公开出口中。

调整方案：

1. 不再依赖 `pi` 内部 helper。
2. 在 `octo` 本地新增一个极小的兼容 helper，例如：
   - 直接放在 `src/runtime/pi-group-runtime-factory.ts`
   - 或抽到 `src/runtime/pi-session-shutdown.ts`
3. 该 helper 仅复现当前所需行为：
   - 如果 `extensionRunner` 不存在，直接返回
   - 如果没有 `session_shutdown` handler，直接返回
   - 否则发送 `{ type: "session_shutdown" }`
4. 这样可以保留现有扩展生命周期语义，同时只依赖 npm 包公开的 `ExtensionRunner` / 相关类型。

示意：

```ts
import type { ExtensionRunner } from "@mariozechner/pi-coding-agent";

async function emitPiSessionShutdown(
  extensionRunner: ExtensionRunner | undefined,
): Promise<void> {
  if (!extensionRunner?.hasHandlers("session_shutdown")) {
    return;
  }

  await extensionRunner.emit({ type: "session_shutdown" });
}
```

然后把 `createPiGroupSessionHost().host.dispose()` 中的逻辑改为调用本地 helper，而不是私有子路径。

### 3.4 测试代码同步切换

当前测试也有相同问题，例如：

```ts
import type { AgentSessionRuntime } from "../pi-mono/packages/coding-agent/src/index.ts";
```

本轮会同步切到：

```ts
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
```

这样测试和正式代码保持同一依赖边界。

### 3.5 范围控制

本轮不做以下事情：

1. 不修改 `pi-mono/` 目录源码或其 `package.json`
2. 不顺带升级 `@mariozechner/pi-coding-agent` 到 `0.67.68`
3. 不大规模改写文档、历史 `specs`、README 中对 `pi-mono` 相对路径的描述
4. 不改变 `octo` 的 Pi runtime 行为，只做依赖入口迁移和最小兼容封装

### 3.6 验证方案

实施后执行以下验证：

1. 类型/构建层面
   - `bun test tests/providers.test.ts`
   - `bun test tests/group-queue.test.ts`
   - `bun test tests/runtime.test.ts`
   - `bun test tests/octo-cli-runtime-host.test.ts`
   - `bun test tests/octo-group-extension.test.ts`

2. 关注点
   - `src` 不再包含 `pi-mono/packages/coding-agent/src` 的导入
   - 测试不再直接依赖本地 `pi-mono` 源码路径
   - `session header` 解析逻辑未回归
   - `session_shutdown` 生命周期仍然会触发

## 4. Todo List

- [x] 在根目录 `package.json` 中新增 `@mariozechner/pi-coding-agent: "0.67.6"`
- [x] 更新 lockfile，使根项目从 npm 安装该依赖
- [x] 将 `src/` 中所有 `pi-mono/packages/coding-agent/src/index.ts` 导入改为 `@mariozechner/pi-coding-agent`
- [x] 移除 `src/cli/octo-cli-runtime-host.ts` 对 `core/session-manager.ts` 私有子路径的依赖，改用公开 API + 本地文件读取
- [x] 移除 `src/runtime/pi-group-runtime-factory.ts` 对 `core/extensions/runner.ts` 私有子路径的依赖，改用 `octo` 本地 helper 保持相同行为
- [x] 将测试中对 `../pi-mono/.../src/index.ts` 的导入改为 npm 包导入
- [x] 搜索并确认 `src/` 与测试中不再残留 `pi-mono/packages/coding-agent/src` 路径引用
- [x] 运行相关测试并处理迁移引入的问题
- [x] 将本规格中的 todo 状态更新为完成
