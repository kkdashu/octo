# MiniMax CN Profile 收敛方案

## 问题描述

当前仓库里的 MiniMax 配置与 Pi-native 语义不一致：

1. `config/agent-profiles.json` 只有 `minimax`
2. 该 profile 实际却指向中国区 endpoint：`https://api.minimaxi.com/anthropic`
3. 同时它读取的是 `MINIMAX_API_KEY`，而不是 Pi 生态约定的 `MINIMAX_CN_API_KEY`
4. 当前 CLI 新 group 默认 profile 还是 `codex`
5. 用户当前正在使用的 CLI group `cli_20260418_171112_23cb05` 也仍然是 `codex`

这会导致两个问题：

1. 从 Octo 视角看，`minimax` / `minimax-cn` 语义混淆
2. 从 Pi 视角看，环境变量名与 provider key 不匹配，后续维护会继续出错

本次需求目标是把 Octo 收敛到与 Pi 一致的语义，并让用户本地 CLI 默认使用 `minimax-cn`。

## 对现有项目的影响

本次变更会影响：

- `config/agent-profiles.json`
- `config/agent-profiles.example.json`
- `README.md`
- `specs/minimax-cn-profile.md`

本次变更还会做一个本地状态迁移：

- `store/messages.db`

迁移范围仅限：

1. 将默认 profile 切到 `minimax-cn`
2. 将当前用户指定的 CLI group `cli_20260418_171112_23cb05` 切到 `minimax-cn`

本次不改动：

- Pi 源码
- `src/runtime/profile-config.ts`
- `src/runtime/pi-group-runtime-factory.ts`
- `src/cli.ts`

原因是现有运行时代码已经支持任意 `profile_key` 动态读取，只要配置文件正确即可。

## 实施方案

### 一、Profile 语义收敛

将当前混合语义拆开，收敛成与 Pi 一致的两条线路：

1. `minimax`
   - `provider = "minimax"`
   - `baseUrl = "https://api.minimax.io/anthropic"`
   - `apiKeyEnv = "MINIMAX_API_KEY"`
2. `minimax-cn`
   - `provider = "minimax-cn"`
   - `baseUrl = "https://api.minimaxi.com/anthropic"`
   - `apiKeyEnv = "MINIMAX_CN_API_KEY"`

这样做的原因：

1. 与 Pi `env-api-keys.ts` / model registry 语义一致
2. 避免以后看到 `minimax` 却实际走中国区 endpoint
3. 后续如果同时支持国际区和中国区，不需要再重构 profile key

目标配置示例：

```json
{
  "defaultProfile": "minimax-cn",
  "profiles": {
    "minimax": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.minimax.io/anthropic",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "model": "MiniMax-M2.7",
      "provider": "minimax"
    },
    "minimax-cn": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "apiKeyEnv": "MINIMAX_CN_API_KEY",
      "model": "MiniMax-M2.7",
      "provider": "minimax-cn"
    }
  }
}
```

### 二、默认 Profile 切换

将 `config/agent-profiles.json` 中：

```json
"defaultProfile": "codex"
```

改为：

```json
"defaultProfile": "minimax-cn"
```

这样新创建的 CLI group 会直接使用中国区 MiniMax。

说明：

1. 这只影响未来新建 group
2. 已有 group 不会自动跟着改
3. 因此还需要单独迁移当前正在使用的 CLI group

### 三、当前 CLI Group 迁移

对当前 group：

```text
cli_20260418_171112_23cb05
```

执行数据库迁移：

```sql
UPDATE registered_groups
SET profile_key = 'minimax-cn'
WHERE folder = 'cli_20260418_171112_23cb05';
```

这样用户重启 CLI 后，该 group 会按 `minimax-cn` 线路启动。

本次不计划批量改所有历史 group，因为这属于用户环境级策略，不应默认全量重写。

### 四、文档同步

更新 `README.md`，明确：

1. `minimax` 与 `minimax-cn` 是两条不同 profile
2. 中国区使用 `MINIMAX_CN_API_KEY`
3. 示例 SQL 中若是中国区场景，应使用 `profile_key = 'minimax-cn'`

### 五、本地环境变量处理

代码仓库层面只需要引用 `MINIMAX_CN_API_KEY`。

本地运行上，用户环境需要满足：

```bash
export MINIMAX_CN_API_KEY=...
```

或在本地 `.env` 中存在：

```bash
MINIMAX_CN_API_KEY=...
```

本次实现默认会同步更新本地 `.env`：

1. 若已存在 `MINIMAX_API_KEY`
2. 且缺少 `MINIMAX_CN_API_KEY`
3. 则将现有值复制到 `MINIMAX_CN_API_KEY`

这样可以保证改完后立刻能在当前机器上使用。

## 验收标准

完成后应满足：

1. `config/agent-profiles.json` 中存在独立的 `minimax-cn`
2. `config/agent-profiles.json` 中的 `defaultProfile` 为 `minimax-cn`
3. `config/agent-profiles.example.json` 中也存在 `minimax-cn`
4. `README.md` 已明确区分 `minimax` 与 `minimax-cn`
5. `registered_groups` 中 `cli_20260418_171112_23cb05` 的 `profile_key` 为 `minimax-cn`
6. 本地环境存在 `MINIMAX_CN_API_KEY`
7. 重启 CLI 后，该 group 不再走 `codex`

## Todo List

- [x] 新增 `specs/minimax-cn-profile.md` 并完成评审
- [x] 修改 `config/agent-profiles.json`，新增 `minimax-cn` 并将默认 profile 切到 `minimax-cn`
- [x] 修改 `config/agent-profiles.example.json`，补齐 `minimax-cn`
- [x] 更新 `README.md` 中关于 MiniMax profile 与 SQL 示例的说明
- [x] 更新本地 `.env`，补齐 `MINIMAX_CN_API_KEY`
- [x] 更新 `store/messages.db`，将 `cli_20260418_171112_23cb05` 的 `profile_key` 改为 `minimax-cn`
- [x] 做最小验证，确认配置文件和数据库迁移结果正确
