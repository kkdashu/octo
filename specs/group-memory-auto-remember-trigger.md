# 群记忆自动触发修复

## 问题说明

当前群记忆功能的后端工具和数据表已经可用，但在用户明确表达“请记住”“以后都这样”“默认按这个来”“这是长期偏好/规则”时，模型并不会稳定调用 `remember_group_memory`。实际表现是模型用自然语言答应了用户，但没有把信息写入 `group_memories`，因此管理页里也看不到对应记录。

另外，群级 `CLAUDE.md` 模板仍然保留旧的“通过文件记忆”的描述，没有明确列出群记忆 MCP 工具和触发规则。现有群目录下的 `CLAUDE.md` 只会在文件不存在时初始化，不会随着模板更新自动同步，因此仅修改模板无法立刻修复已存在群。

## 对现有项目的影响

- 影响运行时会话提示词拼装逻辑
  - `src/group-queue.ts`
- 影响群和主群的提示词模板
  - `groups/GROUP_CLAUDE.md`
  - `groups/MAIN_CLAUDE.md`
- 影响会话恢复策略
  - `src/index.ts`
  - `src/db.ts`
- 影响测试
  - `tests/group-memory.test.ts`

不涉及数据库迁移。当前没有旧数据需要迁移，只需要修复后续触发与会话刷新行为。

## 实现方案

### 1. 在运行时注入统一的群记忆行为规则

在 `src/group-queue.ts` 中为每次新会话构造统一的 memory policy 文本块，并与已有的 group memory 注入逻辑一起拼到 `initialPrompt` 前部。该 policy 不依赖群目录中的 `CLAUDE.md`，因此能立即覆盖所有现有群。

规则需要明确：

- 当用户表达“请记住 / 以后都 / 默认 / 偏好 / 长期规则 / 希望你一直这样做”等长期记忆意图时，先判断是否应写入群记忆。
- 若应写入，必须优先调用 `remember_group_memory`，保存成功后再回复用户。
- key 选择时优先映射到 builtin key：
  - `topic_context`
  - `response_language`
  - `response_style`
  - `interaction_rule`
- 只有 builtin key 无法表达时，才允许使用 custom key。
- 用户要求查看、修改、删除、清空群记忆时，分别使用 `list_group_memory`、`remember_group_memory`、`forget_group_memory`、`clear_group_memory`。

示意：

```ts
const initialPromptWithMemory = buildSessionInitialPrompt(
  initialPrompt,
  memories,
  !resumeSessionId,
);
```

会调整为统一拼接 memory policy 和 memory block，而不是只在有记忆数据时注入。

### 2. 更新主群与普通群模板

更新 `groups/MAIN_CLAUDE.md` 与 `groups/GROUP_CLAUDE.md`：

- 在 Memory 段改为描述群记忆工具，而不是“创建文件记忆”
- 在 Available Tools 中明确列出：
  - `remember_group_memory`
  - `list_group_memory`
  - `forget_group_memory`
  - `clear_group_memory`
- 在模板里说明 builtin key 优先、builtin 不够再 custom

这样可以保证后续新建群目录默认携带正确的约束。

### 3. 启动时清空已持久化的会话 ID，确保修复立即生效

当前会话恢复逻辑会复用持久化 session id。若不清理，已有群可能继续沿用旧会话上下文，短时间内仍然不受新 policy 影响。

因此在启动阶段增加一个“清空所有持久化 session id”的步骤，只清理数据库里的 `sessions` 表，不做其他数据删除。这样下一轮消息会强制走新会话，拿到新的 memory policy。

### 4. 补测试覆盖

在 `tests/group-memory.test.ts` 增加断言，确保：

- 新会话 prompt 一定包含 memory policy
- policy 中明确要求“记住类表达要调用 `remember_group_memory`”
- policy 中明确 builtin key 优先
- scheduler 走同一条会话启动链路时也能拿到 policy

## Todo List

- [x] 新增本次修复 spec
- [x] 在运行时 prompt 中注入统一的群记忆行为规则
- [x] 更新主群和普通群模板中的群记忆说明与工具列表
- [x] 增加清空持久化 session id 的启动逻辑
- [x] 补充群记忆相关测试
- [x] 运行测试与必要构建验证
- [x] 提交本次修复代码
