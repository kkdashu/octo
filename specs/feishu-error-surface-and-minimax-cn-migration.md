# 飞书错误回显与 MiniMax CN 迁移

## 问题描述

当前飞书接入存在两个直接影响可用性的问题：

1. 飞书 group 走新的 Pi-native runtime 后，AI 运行失败只会记日志，不会把失败原因回发到飞书。
2. 现有数据库里仍有部分飞书 group 的 `profile_key = "minimax"`，但当前用户实际环境配置的是中国区 `minimax-cn`。

这会导致用户在飞书里看到“没有回复”，但实际 runtime 已经报错，例如：

```text
401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}
```

同时，已有飞书 group 会继续走国际区 `MINIMAX_API_KEY` 路径，而不是当前可用的 `MINIMAX_CN_API_KEY`。

本次目标是：

1. 飞书侧出现 runtime 错误时，必须把可读错误消息回发给当前群。
2. 将当前数据库里所有 `profile_key = "minimax"` 的 group 统一迁移到 `minimax-cn`。

## 对现有项目的影响

本次变更会影响：

1. `src/runtime/feishu-group-adapter.ts`
   - 增加 runtime 失败回发逻辑
   - 覆盖首轮 `prompt` 失败与 active session follow-up 失败
2. `tests/feishu-group-adapter.test.ts`
   - 增加“失败会回飞书”的测试
3. `store/messages.db`
   - 执行一次性 SQL 数据迁移，把已有 `minimax` groups 改为 `minimax-cn`
4. `specs/feishu-error-surface-and-minimax-cn-migration.md`
   - 记录本次修复范围与完成状态

本次不改动：

1. `config/agent-profiles.json`
   - 已经正确设置 `defaultProfile = "minimax-cn"`
2. Pi 源码
3. 飞书消息内容提取与图片/文件收发逻辑

## 实施方案

### 一、飞书 runtime 错误回发

当前问题点在：

- [src/runtime/feishu-group-adapter.ts](/Volumes/Extra/work/kkdashu/octo/src/runtime/feishu-group-adapter.ts)

当前实现里：

1. `runTurn()` 调用 `sendInput()`
2. 如果 `session.prompt()` / `session.followUp()` / `session.steer()` 抛错
3. 代码只 `log.error(...)`
4. 用户侧飞书没有任何错误提示

修复方式：

1. 增加统一的错误格式化函数，例如：

```ts
function formatRuntimeFailureMessage(error: unknown): string
```

2. 在以下路径统一回发给当前 group：
   - `runTurn()` 中首轮 `prompt` 失败
   - `pushMessage()` 中 follow-up / steer 失败

3. 回发文案策略：
   - 对用户展示简洁错误
   - 保留原始 `error.message`
   - 例如：

```text
AI 运行失败: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}...}
```

4. 日志仍保留完整错误对象，不减少现有日志信息。

### 二、错误回发的边界

本次只处理“当前 turn 失败但用户看不到”的问题，不引入额外复杂度：

1. 不做飞书消息编辑
2. 不做分片流式错误提示
3. 不把 Pi 的所有 diagnostic event 都回发到飞书
4. 仅在真正导致当前请求失败时发送一条错误消息

这样可以保证：

1. 用户知道失败了
2. 群里不会出现过多技术噪音
3. 现有 `message_end -> 单条飞书消息` 边界保持不变

### 三、数据库里的 `minimax -> minimax-cn` 迁移

当前已确认数据库里存在以下 group 仍然使用 `minimax`：

1. `main`
2. `feishu_oc_264c92d2efc9c764cd949d527b0026cd`

本次直接做一次性数据迁移：

```sql
UPDATE registered_groups
SET profile_key = 'minimax-cn'
WHERE profile_key = 'minimax';
```

原因：

1. 当前默认 profile 已经是 `minimax-cn`
2. 用户明确希望把数据库里的 `minimax` 统一切到 `minimax-cn`
3. 这是现网状态修正，不需要额外增加代码级迁移器

迁移后验证：

```sql
SELECT folder, profile_key
FROM registered_groups
ORDER BY folder;
```

预期所有原本为 `minimax` 的记录都变为 `minimax-cn`。

### 四、测试方案

新增或更新测试覆盖：

1. `FeishuGroupAdapter` 在 `session.prompt()` 抛错时会通过 `ChannelManager.send()` 回发错误
2. `FeishuGroupAdapter` 在 active session follow-up 失败时也会回发错误
3. 现有成功路径不回归：
   - 正常 assistant reply 仍按原路径发送
   - `session_ref` 仍在成功 turn 后更新

数据库迁移做最小验证：

1. 执行 SQL 更新
2. 查询 `registered_groups`
3. 确认不再存在 `profile_key = "minimax"` 的记录

## Todo List

- [x] 新增飞书 runtime 错误格式化与回发逻辑
- [x] 覆盖首轮 `prompt` 失败场景
- [x] 覆盖 active session follow-up 失败场景
- [x] 补充 `tests/feishu-group-adapter.test.ts`
- [x] 执行数据库迁移：`minimax -> minimax-cn`
- [x] 验证迁移结果与相关测试
