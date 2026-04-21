# 清理本地旧数据脚本规格

## 问题描述

当前 `octo` 已经从以 `group` 为中心的模型逐步切到以 `workspace/chat` 为中心的模型，但本地开发目录里仍然可能残留大量旧数据：

1. `store/messages.db` 及其 SQLite sidecar 文件
2. `groups/<folder>/` 下的 legacy group 目录、旧 `.pi/sessions`、旧截图、旧技能产物
3. `groups/` 根目录下同时还保留着模板文件：
   - `groups/MAIN_AGENTS.md`
   - `groups/GROUP_AGENTS.md`

如果继续拿这些旧数据跑当前版本，会出现两个问题：

1. 数据库里的旧绑定、旧 session、旧 runtime 状态会干扰新模型调试
2. `groups/` 下的 legacy 目录会让排障时混淆“当前真实 workspace 数据”和“历史 group 残留数据”

用户希望提供一个放在 `scripts/` 目录下的脚本，用于：

1. 清理数据库
2. 删除 `groups/` 目录下的旧数据文件

这里必须明确一个边界：

1. 不能直接把 `groups/` 全删
2. 因为 `groups/MAIN_AGENTS.md` 和 `groups/GROUP_AGENTS.md` 仍然是当前 workspace 初始化模板
3. 如果误删模板，会导致后续新 workspace 初始化缺少 `AGENTS.md` 模板来源

所以本次脚本的真实目标应为：

```text
重置本地运行态与 legacy group 数据
但保留当前系统仍依赖的模板文件
```

## 对现有项目的影响

本次只新增本地开发脚本，不改线上运行逻辑，但会影响以下位置：

1. `scripts/`
   - 新增清理脚本入口
2. `store/`
   - 删除：
     - `store/messages.db`
     - `store/messages.db-shm`
     - `store/messages.db-wal`
3. `groups/`
   - 删除 legacy group 目录和其中所有文件
   - 保留：
     - `groups/MAIN_AGENTS.md`
     - `groups/GROUP_AGENTS.md`
4. 测试
   - 需要新增脚本行为测试，防止误删模板文件或误删非目标目录

非目标：

1. 不清理 `workspaces/`
2. 不清理 `logs/`
3. 不清理 `skills/`
4. 不清理用户 home 目录下的 `~/.octo/cli-state.json`
5. 不修改数据库 schema，不做迁移逻辑

之所以不碰 `workspaces/`，是因为用户当前只要求清理数据库与 `groups/` 目录；`workspaces/` 是当前新模型的真实工作区，默认不应被这个脚本误删。

## 实现方案

### 一、脚本文件位置与执行方式

脚本放在：

```text
scripts/reset-local-state.ts
```

执行方式：

```bash
bun scripts/reset-local-state.ts
```

为了避免误操作，脚本采用：

1. 默认需要显式确认
2. 支持 `--yes` 跳过确认
3. 支持 `--dry-run` 只打印将删除的路径，不实际删除

示例：

```bash
bun scripts/reset-local-state.ts --dry-run
bun scripts/reset-local-state.ts --yes
```

### 二、删除目标

脚本只处理仓库根目录下的以下目标：

#### 1. 数据库文件

固定删除：

```text
store/messages.db
store/messages.db-shm
store/messages.db-wal
```

如果文件不存在，脚本只记录为 skipped，不报错。

#### 2. `groups/` 下的 legacy 数据

扫描 `groups/` 目录的直接子项：

1. 若是以下模板文件，则保留：
   - `MAIN_AGENTS.md`
   - `GROUP_AGENTS.md`
2. 其余目录、普通文件、符号链接，全部删除

也就是说，类似下面这些都会被删：

```text
groups/main/
groups/cli_20260419_xxx/
groups/some-old-group/
groups/random-file.png
```

但下面这些必须保留：

```text
groups/MAIN_AGENTS.md
groups/GROUP_AGENTS.md
```

### 三、安全策略

脚本必须包含以下保护：

#### 1. 路径边界保护

所有删除路径必须先 resolve 到仓库根目录下，并确认满足：

1. 数据库文件必须位于 `<root>/store/`
2. legacy group 删除对象必须位于 `<root>/groups/`

避免因为路径拼接错误删到仓库外部。

#### 2. 模板文件保护

即使用户传 `--yes`，也绝不删除：

1. `groups/MAIN_AGENTS.md`
2. `groups/GROUP_AGENTS.md`

#### 3. 可预览

`--dry-run` 时输出：

1. 将删除的文件列表
2. 将删除的目录列表
3. 将保留的模板列表

#### 4. 明确摘要

脚本执行结束后打印结构化摘要，例如：

```text
Deleted files: 3
Deleted directories: 4
Skipped missing: 2
Preserved templates: 2
```

### 四、代码结构

为了便于测试，脚本不应把逻辑全部塞进顶层 `main`。

建议结构：

```text
scripts/reset-local-state.ts
  - parseArgs(argv)
  - collectResetPlan(rootDir)
  - executeResetPlan(plan, dryRun)
  - printSummary(summary)
```

核心数据结构示意：

```ts
interface ResetPlan {
  filesToDelete: string[];
  directoriesToDelete: string[];
  preservedPaths: string[];
}

interface ResetSummary {
  deletedFiles: string[];
  deletedDirectories: string[];
  skippedMissing: string[];
  preservedPaths: string[];
  dryRun: boolean;
}
```

这样后续测试可以直接验证：

1. plan 收集是否正确
2. 是否保留模板
3. 是否只删除 `groups/` 下非模板目标

### 五、测试方案

新增测试文件，例如：

```text
tests/reset-local-state.test.ts
```

测试覆盖点：

1. `collectResetPlan()` 会收集数据库文件
2. `collectResetPlan()` 会保留 `groups/MAIN_AGENTS.md` 与 `groups/GROUP_AGENTS.md`
3. `collectResetPlan()` 会收集 `groups/` 下其他目录/文件
4. `executeResetPlan()` 在 `dryRun` 下不实际删除
5. `executeResetPlan()` 实际执行时会删除目标但保留模板

## Todo List

- [ ] 新增 `specs/reset-local-state-script.md`
- [ ] 在 `scripts/` 下新增 `reset-local-state.ts`
- [ ] 实现参数解析：`--yes`、`--dry-run`
- [ ] 实现数据库文件收集逻辑
- [ ] 实现 `groups/` 目录扫描与模板保留逻辑
- [ ] 实现删除执行逻辑与摘要输出
- [ ] 为脚本核心逻辑补充测试
- [ ] 运行相关测试并验证脚本行为
