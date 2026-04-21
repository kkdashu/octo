# Agent Profiles Path Hardening

## 问题说明

当前 `agent profile` 配置加载依赖 `src/runtime/profile-config.ts` 中的 `resolve("config/agent-profiles.json")` 或 `resolve(process.env.AGENT_PROFILES_PATH)`。

这个实现默认使用“当前进程的 `cwd`”作为相对路径基准，因此当运行时把工作目录切到某个 workspace，例如：

- `/Users/kkdashu/work/octo/workspaces/feishu_cli_a9231030b2b89bdf`

再去加载配置时，就会错误地把配置文件解析成：

- `/Users/kkdashu/work/octo/workspaces/feishu_cli_a9231030b2b89bdf/config/agent-profiles.json`

而实际存在的配置文件在仓库根目录：

- `config/agent-profiles.json`

这会直接导致：

1. `/clear` 清理 session 失败
2. 飞书新消息无法创建/恢复运行时
3. 运行时日志反复出现 `Agent profile config not found`

从现有代码看，CLI 和 Desktop sidecar 已经有“启动时把 `AGENT_PROFILES_PATH` 固定为绝对路径”的逻辑，但 `src/index.ts` 没有同样的处理，因此 Feishu 主入口仍然会暴露这个问题。

## 对现有项目的影响

受影响的模块和文件：

- `src/runtime/profile-config.ts`
  - 负责 profile 配置路径解析、读取、缓存
- `src/index.ts`
  - Feishu 主服务启动入口，目前缺少和 CLI/Desktop 对齐的路径归一化
- `src/cli.ts`
  - 已有类似逻辑，适合收敛到共享实现
- `src/desktop/main.ts`
  - 已有类似逻辑，适合收敛到共享实现
- `tests/runtime.test.ts`
  - 适合补 profile-config 层的路径漂移测试
- `tests/cli-bootstrap.test.ts`
  - 需要跟随共享 helper 调整或复用
- `tests/desktop-main.test.ts`
  - 需要跟随共享 helper 调整或复用

不会影响数据库 schema，也不会改变已有 profile 配置格式。影响范围主要是运行时 bootstrap 和配置解析行为。

## 实现方案

### 目标

确保 `agent-profiles.json` 的解析不再依赖“运行时当前 `cwd`”，而是依赖“服务启动根目录”或已经归一化后的绝对路径。

### 方案概览

分两层修复：

1. 在 `profile-config` 中抽出共享的路径归一化 helper
2. 在 `src/index.ts` 启动时调用该 helper，并让 CLI/Desktop 复用同一实现

这样可以同时解决：

- Feishu 主入口未做绝对路径归一化的问题
- CLI/Desktop 与主入口存在重复实现、行为可能漂移的问题

### 具体改动

#### 1. 在 `src/runtime/profile-config.ts` 中新增共享 helper

新增一个显式的启动期 helper，例如：

```ts
export function ensureAgentProfilesPath(rootDir: string): string {
  const configured = process.env.AGENT_PROFILES_PATH?.trim();
  const fallbackCandidates = [
    resolve(rootDir, "config/agent-profiles.json"),
    resolve(rootDir, "config/agent-profiles.example.json"),
  ];

  const configuredCandidate = configured
    ? resolve(rootDir, configured)
    : null;

  const resolvedPath = [
    ...(configuredCandidate ? [configuredCandidate] : []),
    ...fallbackCandidates,
  ].find((candidate) => existsSync(candidate)) ?? fallbackCandidates[0]!;

  process.env.AGENT_PROFILES_PATH = resolvedPath;
  return resolvedPath;
}
```

关键决策：

- `resolve(rootDir, configured)` 要统一使用启动根目录 `rootDir`，不能直接用 `resolve(configured)`。
- helper 的职责是“在启动期把环境变量钉死为绝对路径”，后续运行时只消费这个已经稳定的值。
- fallback 顺序保持现有行为：
  1. `config/agent-profiles.json`
  2. `config/agent-profiles.example.json`

#### 2. 收敛 `resolveAgentProfilesPath()` 的候选路径逻辑

`resolveAgentProfilesPath()` 继续负责返回最终加载路径，但内部改为优先信任已经归一化后的 `process.env.AGENT_PROFILES_PATH`。

如果实现时发现有必要，可补一个轻量防御：

```ts
if (!existsSync(configPath) && cachedConfig?.path && existsSync(cachedConfig.path)) {
  log.warn(TAG, "Configured agent profiles path became invalid, reusing cached path", {
    configuredPath: configPath,
    cachedPath: cachedConfig.path,
  });
  return cachedConfig.path;
}
```

这个防御不是核心修复，但它可以避免后续某个运行时再次把相对路径污染回来时，已成功加载过的服务立刻崩掉。

#### 3. 在 `src/index.ts` 启动时补齐归一化

主入口在任何 `loadAgentProfilesConfig()` 调用之前，执行：

```ts
const rootDir = process.cwd();
ensureAgentProfilesPath(rootDir);
```

建议位置：

- `initDatabase(...)` 前
- `WorkspaceService` 创建前
- 任何 `getDefaultProfileKey()` 前

这样 Feishu runtime 在创建 workspace、chat、session、执行 `/clear`、处理新消息时，都会使用绝对路径配置。

#### 4. CLI 与 Desktop 改为复用共享 helper

把下面两处自带的重复逻辑替换为共享 helper：

- `src/cli.ts` 中的 `ensureCliAgentProfilesPath`
- `src/desktop/main.ts` 中的 `ensureAgentProfilesPath`

替换方式有两种，优先选择更小改动的方案：

1. 保留现有函数名，但内部直接委托给 `profile-config` 的共享 helper
2. 删除局部实现，直接调用共享 helper

目标是只保留一套路径归一化规则，避免三个入口之后再次出现分叉。

### 测试方案

#### 1. `profile-config` 单测

在 `tests/runtime.test.ts` 增加一组用例，覆盖：

- 当 `AGENT_PROFILES_PATH="config/agent-profiles.json"` 且 `rootDir` 下存在真实配置时，`ensureAgentProfilesPath(rootDir)` 会把环境变量改成绝对路径
- 在 `ensureAgentProfilesPath(rootDir)` 之后，即使 `process.chdir()` 到 workspace 目录，`resolveAgentProfile()` 仍然可以成功加载配置
- 当显式配置不存在时，会回退到根目录 `config/agent-profiles.json` 或 `config/agent-profiles.example.json`

示意测试：

```ts
const rootDir = mkdtempSync(...);
mkdirSync(join(rootDir, "config"), { recursive: true });
writeFileSync(join(rootDir, "config", "agent-profiles.json"), ...);

process.env.AGENT_PROFILES_PATH = "config/agent-profiles.json";
ensureAgentProfilesPath(rootDir);

process.chdir(join(rootDir, "workspaces", "demo"));
expect(resolveAgentProfile("claude").profileKey).toBe("claude");
```

#### 2. CLI bootstrap 测试

`tests/cli-bootstrap.test.ts` 继续验证：

- 相对路径会被固定到 startup root
- 未设置时会回退到 root config

如果 CLI 改为委托共享 helper，这些测试应该仍然成立，只需要对测试目标函数做适配。

#### 3. Desktop bootstrap 测试

`tests/desktop-main.test.ts` 继续验证：

- `AGENT_PROFILES_PATH` 为空时会落到 root config
- 相对路径会被转换成绝对路径
- 无效路径会回退到 root config

### 架构取舍

选择“共享 helper + 主入口补齐”而不是只在 `src/index.ts` 临时补一段同类代码，原因如下：

1. 现在已经有三套相似逻辑，继续复制只会让行为越来越难维护
2. 真正的问题不是某一行路径，而是“路径基准不稳定”
3. `profile-config` 是所有入口都会用到的公共层，把规则收敛到这里更容易保证一致性

不建议只做“在报错时提示用户设置 `AGENT_PROFILES_PATH`”这种表面修复，因为仓库根目录本来就有配置文件，问题在代码路径解析，不在用户配置缺失。

## Todo List

- [x] 在 `src/runtime/profile-config.ts` 中抽出共享的 `ensureAgentProfilesPath(rootDir)` 逻辑
- [x] 让 `src/index.ts` 在启动早期调用共享 helper，固定 `AGENT_PROFILES_PATH`
- [x] 让 `src/cli.ts` 复用共享 helper，删除或收敛重复实现
- [x] 让 `src/desktop/main.ts` 复用共享 helper，删除或收敛重复实现
- [x] 评估 `resolveAgentProfilesPath()` 的防御性 fallback；当前共享 helper 已覆盖主问题，暂不增加额外分支
- [x] 在 `tests/runtime.test.ts` 中增加“cwd 漂移后仍能加载 profile”测试
- [x] 更新 `tests/cli-bootstrap.test.ts`，确保 CLI bootstrap 行为保持正确
- [x] 更新 `tests/desktop-main.test.ts`，确保 Desktop bootstrap 行为保持正确
- [x] 运行相关测试并确认无回归
