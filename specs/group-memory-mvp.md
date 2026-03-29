# 群级记忆 MVP 方案（以英语学习群为例）

## 问题描述

当前 Octo 已经具备以下能力：

- 群级独立工作目录
- 群级独立 Claude session
- 定时任务调度
- 主群跨群管理
- 基于 SQLite 的状态持久化

但系统目前缺少一种 **跨 session 的长期记忆能力**。

现状是：

1. Claude session 可以保留短期上下文，但当 session 被清空、失效或重新开始后，系统无法稳定记住“这个群长期是做什么的、偏好什么风格、有哪些固定规则”。
2. 定时任务虽然能定期执行 prompt，但缺少一层“群长期设定”，导致任务输出更像一次性 prompt 生成，而不是带有稳定人格和目标的长期服务。
3. 群的长期用途无法沉淀为结构化上下文，用户需要反复重复说明，体验不稳定。

以“英语学习群”为例，用户可能希望系统长期记住：

- 这个群主要用于英语学习
- 默认中文讲解、英文举例
- 重点提升口语
- 回答风格要像老师一样循序渐进
- 每次练习尽量控制在 5 分钟以内

如果没有记忆功能，这些设定只能存在于当前 session 里，或者靠用户反复强调。

因此需要增加一个 **数据库驱动的群级记忆 MVP**，让群的长期设定能够跨 session 持续生效，并被定时任务复用。

## 对现有项目的影响

### 需要修改的文件

- `src/db.ts`
  - 新增 `group_memories` 表
  - 新增 group memory 的增删改查 helper
- `src/tools.ts`
  - 新增 memory 管理工具
  - 处理主群跨群操作权限
- `src/group-queue.ts`
  - 在启动新 session 时读取 group memory
  - 将 memory 摘要注入初始 prompt
- `src/task-scheduler.ts`
  - 确保定时任务走的群上下文也能读取 memory（若当前链路已经复用 `GroupQueue.enqueue()`，则可能不需要结构性改动，但需要明确验证）
- `tests/`
  - 增加 memory 数据层测试
  - 增加工具权限测试
  - 增加 session prompt 注入测试
- `README.md` / `docs/octo.md`
  - 补充 memory MVP 的说明（如本次实现后需要对外说明）

### 预计不需要修改的文件

- `src/providers/claude.ts`
  - Claude runtime 本身不需要知道 memory 的数据库结构；只需要接收最终拼好的 prompt
- `src/runtime/openai-proxy.ts`
- `src/runtime/anthropic-logging-proxy.ts`
- `src/channels/*`
  - memory 逻辑不在消息通道层

### 风险与兼容性

1. **不能把 memory 做成聊天记录归档**
   - 本次 memory 只存“长期稳定设定”，不存全部聊天内容
2. **不能让 prompt 注入无限膨胀**
   - memory 摘要必须简短可控，避免拉长每次新 session 的系统上下文
3. **主群跨群管理要延续现有权限模型**
   - 普通群只能管理自己的 memory
   - 主群可以管理其他群
4. **MVP 不做自动提取**
   - 避免误记、乱记和难以调试的问题

## MVP 范围

### 本次要做

- 只做 **数据库存储的 group memory**
- 只做 **显式写入** memory
- 支持 **查看 / 删除 / 清空** memory
- 支持 **新 session 启动时自动注入 group memory**
- 支持 **定时任务执行时复用 group memory**
- 支持 **主群跨群管理 memory**
- key 采用 **固定 key 优先 + 可扩展 custom key** 的模式

### 本次不做

- 不做 user 级 memory
- 不做 project 级 memory
- 不做自动从聊天中抽取 memory
- 不做 embedding / semantic retrieval
- 不做 Markdown 作为主存储
- 不做学习进度追踪、错题本、掌握度模型
- 不做 active session 期间的 memory 热更新

## 典型场景：英语学习群

假设存在一个群，它的定位是：

> 这个群专门用来教我学习英语。

管理员希望系统长期记住以下信息：

- 这个群主要用于英语学习
- 默认中文讲解，英文举例
- 重点提升英语口语
- 回答风格像英语老师，循序渐进、鼓励式
- 每次练习尽量控制在 5 分钟以内

随后管理员再创建一个定时任务，例如：

- 每天早上 8 点发送今日英语练习

期望结果是：

- 这个定时任务以后不只是泛泛地产出英语内容
- 而是会稳定地产出符合该群长期设定的英语学习内容
- 即使 Claude session 被清空或重建，这些设定仍然有效

这个例子将作为本次 MVP 的主要验收样例。

## 用户故事

### 1. 作为群管理员
我希望告诉系统：

- 这个群主要用于英语学习
- 默认中文讲解、英文举例
- 重点练口语
- 回答要像老师一样耐心

这样以后即使 session 重启，系统也能继续按这个设定工作。

### 2. 作为群管理员
我希望查看当前群已经记住了什么，避免重复设置或忘记已有配置。

### 3. 作为群管理员
我希望删除某条不再适用的记忆，或者清空整个群的记忆，重新配置。

### 4. 作为主群管理员
我希望可以跨群管理其他群的记忆，例如：

- 给某个英语学习群设置教学风格
- 查看某个群当前记住了什么
- 清空某个群的记忆

### 5. 作为群成员
我希望每天收到的定时学习内容能符合这个群的长期设定，而不是每次都像第一次认识这个群。

## 记忆模型

### 一、scope

MVP 只支持一种 scope：

- `group`

即每条记忆都绑定到一个 `group_folder`。

### 二、数据结构

每条记忆至少包含：

- `group_folder`
- `key`
- `key_type`
- `value`
- `source`
- `created_at`
- `updated_at`

其中：

- `key_type` 取值：`builtin | custom`
- `source` MVP 先支持：`user | tool`

### 三、key 策略

本次 MVP 采用：

**固定 key 优先，可控扩展补充**

#### 1. builtin key（固定 key）

第一版建议内置以下 key：

- `topic_context`
  - 这个群长期是做什么的
  - 例：`这个群主要用于英语学习`
- `study_goal`
  - 该群的学习/使用目标
  - 例：`重点提升英语口语`
- `response_language`
  - 输出语言偏好
  - 例：`中文讲解，英文举例`
- `response_style`
  - 输出风格
  - 例：`像英语老师一样循序渐进，语气鼓励式`
- `interaction_rule`
  - 长期交互规则
  - 例：`每次练习尽量控制在5分钟以内，并给出例句`
- `difficulty_level`
  - 难度偏好
  - 例：`初级` / `中级` / `偏口语交流`

#### 2. custom key（扩展 key）

当 builtin key 无法表达某群的长期设定时，允许增加 custom key。

例如英语学习群可能扩展：

- `teacher_persona`
  - 例：`像耐心的一对一家教`
- `correction_policy`
  - 例：`用户发英文时优先纠错再解释`
- `daily_focus`
  - 例：`当前阶段重点训练口语表达`

约束：

- custom key 必须使用小写字母 + 下划线命名
- 仅在 builtin key 不够表达时使用
- 不允许把一次性任务状态写成 custom key

### 四、数据库表草案

建议新增表：

```sql
CREATE TABLE IF NOT EXISTS group_memories (
  group_folder TEXT NOT NULL,
  key TEXT NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'builtin',
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_folder, key)
);
```

说明：

- 一个群的同一个 key 只有一条记录
- 重复写入同一个 key 时走 upsert
- `key_type` 用于区分系统内置 key 与扩展 key

## 功能设计

### 一、记住一条记忆

支持为当前群新增或覆盖一条 memory。

示例：

- 记住这个群主要用于英语学习
- 记住这个群重点提升口语
- 记住这个群默认中文讲解英文举例

行为：

- 若 key 不存在，则新增
- 若 key 已存在，则覆盖 `value` 并更新 `updated_at`

### 二、查看当前群记忆

支持列出当前群所有 memory。

示例：

- 查看这个群的记忆
- 这个群记住了什么

输出要求：

- 按 builtin / custom 分组显示
- 文案简洁可读

### 三、删除一条记忆

支持删除某个 key。

示例：

- 忘记这个群的回答风格
- 删除这个群的 difficulty_level

### 四、清空群记忆

支持删除某个群的全部 memory。

示例：

- 清空这个群的记忆

### 五、主群跨群管理

主群允许指定 `targetGroupFolder` 对其他群执行：

- 记住
- 查看
- 删除
- 清空

普通群仅允许操作自己的 memory。

## 工具层草案

MVP 建议增加 4 个工具：

- `remember_group_memory`
- `list_group_memory`
- `forget_group_memory`
- `clear_group_memory`

### remember_group_memory

参数：

- `key`
- `value`
- `keyType?`（默认 `builtin`）
- `targetGroupFolder?`

规则：

- 普通群不能指定其他群
- 主群可以指定目标群
- 若 `keyType = builtin`，则 `key` 必须属于内置集合
- 若 `keyType = custom`，则 `key` 必须满足命名规范

### list_group_memory

参数：

- `targetGroupFolder?`

### forget_group_memory

参数：

- `key`
- `targetGroupFolder?`

### clear_group_memory

参数：

- `targetGroupFolder?`

## Prompt 注入设计

### 一、何时注入

只在 **新 session 启动时** 注入 group memory。

即：

- 当当前群没有 active session，需要启动新 Claude session 时
- 从数据库读取该群 memory
- 组装成一个简短的 memory block
- 附加到初始 prompt 中

### 二、不做的事

MVP 不要求：

- 对运行中的 active session 做 memory 热更新
- 新增 memory 后立刻影响当前正在执行的 turn

这样可以降低复杂度，并与现有 session persistence 模型保持一致。

### 三、注入格式建议

建议转成短文本摘要，而不是把原始数据库结构直接暴露给模型。

示例：

```text
Group memory:
- This group is mainly for learning English.
- Study goal: improve spoken English.
- Preferred explanation language: Chinese, with English examples.
- Preferred style: patient, teacher-like, encouraging.
- Interaction rule: keep each exercise within 5 minutes.
- Difficulty level: beginner to intermediate.
```

注入规则：

1. 优先注入 builtin key
2. custom key 作为补充
3. 总长度必须受控，避免 prompt 膨胀

## 与定时任务的关系

### 一、职责分工

- memory = 群长期设定
- scheduled task = 触发时机 + 任务 prompt

### 二、英语学习群示例

管理员先写入 memory：

- `topic_context = 这个群主要用于英语学习`
- `study_goal = 重点提升口语`
- `response_language = 中文讲解，英文举例`
- `response_style = 像英语老师一样循序渐进`
- `interaction_rule = 每次练习控制在5分钟以内`

再创建定时任务：

- 每天 8 点发送今日英语练习

期望结果：

- 后续每次任务执行时，系统都能读取该群 memory
- 定时任务生成的内容自动符合这个群的长期学习设定
- 不需要在每条 task prompt 中重复写完整背景

### 三、实现边界

若当前调度链路已经通过 `GroupQueue.enqueue()` 进入统一会话启动逻辑，则 memory 注入可以天然复用；本次实现阶段只需要验证该链路是否成立。

## 实施方案

### Phase 1：数据层

1. 在 `src/db.ts` 中新增 `group_memories` 表
2. 新增以下 helper：
   - `listGroupMemories()`
   - `upsertGroupMemory()`
   - `deleteGroupMemory()`
   - `clearGroupMemories()`
3. 增加 key 校验辅助方法（builtin / custom）

### Phase 2：工具层

1. 在 `src/tools.ts` 中新增 4 个 memory 工具
2. 复用当前主群跨群权限模式
3. 返回简洁、可读的结果文案

### Phase 3：会话注入

1. 在 `src/group-queue.ts` 中读取目标群 memory
2. 将 memory 摘要拼接到新 session 的初始 prompt
3. 确保不会影响已有 active session 的 follow-up push 逻辑

### Phase 4：验证定时任务复用

1. 确认 scheduler 执行路径会走统一会话启动逻辑
2. 确认定时任务创建的新 session 同样能注入 memory
3. 为英语学习群场景增加测试用例

### Phase 5：测试

新增或扩展测试：

- 数据库层 CRUD 测试
- builtin/custom key 校验测试
- 工具权限测试（普通群 vs 主群）
- 新 session prompt 注入测试
- 定时任务复用 memory 的测试

## 成功标准

如果以下能力全部成立，则本次 MVP 视为完成：

1. 能为某个群写入一条长期 memory
2. 能查看该群当前全部 memory
3. 能删除一条 memory 或清空全部 memory
4. 主群可以跨群管理 memory
5. 新 session 启动时会自动参考该群 memory
6. 定时任务执行时也能体现该群 memory
7. “英语学习群”能稳定表现为具有固定教学风格和学习目标的群

## 非目标

以下内容明确不属于本次 MVP：

- 自动从聊天中抽取 memory
- user 级 memory
- project 级 memory
- embedding / semantic retrieval
- Markdown 作为主存储
- 学习进度跟踪
- 错题本 / 单词掌握度 / SRS 复习系统

## Todo List

### Phase 1：数据层
- [ ] 在 `src/db.ts` 中新增 `group_memories` 表
- [ ] 新增 group memory CRUD helper
- [ ] 增加 builtin/custom key 校验辅助逻辑

### Phase 2：工具层
- [ ] 在 `src/tools.ts` 中新增 `remember_group_memory`
- [ ] 在 `src/tools.ts` 中新增 `list_group_memory`
- [ ] 在 `src/tools.ts` 中新增 `forget_group_memory`
- [ ] 在 `src/tools.ts` 中新增 `clear_group_memory`
- [ ] 实现普通群/主群的权限校验

### Phase 3：会话注入
- [ ] 在 `src/group-queue.ts` 中读取 group memory
- [ ] 在新 session 启动时注入 memory 摘要
- [ ] 保持 active session follow-up push 逻辑不变

### Phase 4：定时任务验证
- [ ] 验证 scheduler 经过统一 session 启动链路
- [ ] 确保定时任务也能读取和使用 group memory
- [ ] 用英语学习群场景补充验收用例

### Phase 5：测试与文档
- [ ] 增加数据库 CRUD 测试
- [ ] 增加 memory 工具测试
- [ ] 增加 session prompt 注入测试
- [ ] 增加定时任务读取 memory 的测试
- [ ] 视实现情况更新 README 或 docs/octo.md
