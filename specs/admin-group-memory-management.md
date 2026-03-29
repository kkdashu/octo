# Admin 管理页群记忆管理方案

## 问题描述

当前群级记忆 MVP 已经具备：

- 数据库存储 `group_memories`
- tool 层的新增 / 查看 / 删除 / 清空
- 新 session 与定时任务的 memory 注入

但本地管理页 `src/admin` 还不能直接管理群记忆。

现状问题：

1. 管理员只能通过 agent tool 间接查看或修改 memory，缺少可视化入口。
2. 管理页当前只支持群设置和工作目录文件浏览，无法直接检查某个群到底记住了什么。
3. 当某条 memory 写错、过期、或者需要手动修正时，没有一个稳定的运维面板可用。

因此需要在 admin 管理页中增加 **群记忆的查看、修改、删除能力**，让管理员能够在 localhost 面板内直接维护每个群的长期记忆。

## 对现有项目的影响

### 需要修改的文件

- `src/admin/types.ts`
  - 新增 admin 群记忆 DTO / response 类型
- `src/admin/api.ts`
  - 新增群记忆查询 / upsert / delete API
  - 在群详情接口中补充 memories，避免前端额外发一次初始请求
- `src/admin/server.ts`
  - 新增 admin memory 路由
- `src/admin/api-client.ts`
  - 新增 memory 相关请求方法
- `src/admin/App.tsx`
  - 增加 memory 列表、编辑表单、保存与删除交互
- `src/admin/styles.css`
  - 为 memory 面板补样式
- `tests/admin-api.test.ts`
  - 增加 admin memory API 的测试

### 预计不需要修改的文件

- `src/group-queue.ts`
- `src/task-scheduler.ts`
- `src/providers/*`
- `src/channels/*`
- `src/tools.ts`
  - 本次是 admin 面板接入，tool 行为本身不需要调整

## 实现目标

本次 admin 管理页需要支持：

- 查看当前群已有的全部 memory
- 新增一条 memory
- 修改已有 memory 的 `value`
- 删除某条 memory

本次明确不做：

- admin 页“一键清空全部 memory”
- 在 admin 页里自动帮用户做语义归纳
- active session 热更新
- user/project 级 memory

## 交互设计

### 一、页面布局

当前页面是：

- 左侧群列表
- 右侧直接并排显示 `群设置 / 文件浏览 / 文本编辑器`

本次调整为：

- 第一列：群列表
- 第二列：当前选中群的二级导航
- 第三列：当前二级导航对应的内容区

二级导航固定包含：

- `群设置`
- `群记忆`
- `文件浏览`

交互规则：

- 用户先在最左侧选择一个群
- 再在二级导航里切换当前功能页
- 同一时刻内容区只显示一个页面，不再把多个面板并排展开

这样做的原因是：

- 管理页功能已经从“群设置 + 文件编辑”扩展到包含群记忆
- 如果继续横向并排，信息密度会过高，窄屏也更难处理
- 二级导航更适合持续扩展后续功能

在窄屏下：

- 第一列、第二列、第三列改为纵向堆叠
- 群列表仍然优先显示
- 二级导航显示为横向按钮组或换行按钮组
- 内容区只显示当前选中的子页面

### 二、群记忆页面结构

当二级导航选中 `群记忆` 时，内容区包含两部分：

1. **记忆列表**
   - 按 builtin / custom 分组
   - 展示 `key`、`key_type`、`value`
   - 每项提供“编辑”“删除”
2. **编辑表单**
   - `key`
   - `keyType`
   - `value`
   - “保存记忆”按钮
   - “新建记忆”按钮

### 三、文件浏览页面结构

当二级导航选中 `文件浏览` 时，内容区保留现有两块内容：

- 文件列表
- 文本编辑器

也就是把当前“文件浏览 + 文件编辑”的组合，整体收拢为一个二级页面，而不是拆成两个顶层面板。

### 四、编辑行为约束

为了降低复杂度，本次采取：

- **已有 memory 不支持直接改 key**
- 编辑已有 memory 时：
  - `key` 只读展示
  - 允许修改 `value`
  - `keyType` 只读展示
- 若需要把某个 key 改名：
  - 先删除旧 key
  - 再新增新 key

这样可以避免处理 “修改主键 = rename key” 的额外 API 复杂度。

### 五、新建行为

点击“新建记忆”后，表单切换到可编辑模式：

- `key` 可输入
- `keyType` 可切换
- `value` 可输入

并在表单附近明确提示：

- 优先使用 builtin key：
  - `topic_context`
  - `response_language`
  - `response_style`
  - `interaction_rule`
- 只有 builtin key 不够表达时才使用 custom key

## API 设计

### 一、扩展群详情响应

当前 `GET /api/admin/groups/:folder` 返回：

```ts
type AdminGroupDetailResponse = {
  group: AdminGroupDto;
  availableProfiles: AdminProfileOption[];
};
```

本次改为：

```ts
type AdminGroupDetailResponse = {
  group: AdminGroupDto;
  availableProfiles: AdminProfileOption[];
  memories: AdminGroupMemoryDto[];
};
```

这样前端选中某个群时，一次请求即可拿到：

- 群信息
- AI profile 选项
- 当前 memory 列表

### 二、新增 memory DTO

建议新增：

```ts
type AdminGroupMemoryDto = {
  key: string;
  keyType: "builtin" | "custom";
  value: string;
  source: "user" | "tool";
  createdAt: string;
  updatedAt: string;
};
```

### 三、新增 memory 写接口

建议新增：

- `PUT /api/admin/groups/:folder/memory`

请求体：

```json
{
  "key": "topic_context",
  "keyType": "builtin",
  "value": "这个群主要用于英语学习"
}
```

行为：

- 校验 group 是否存在
- 校验 `key` / `keyType`
- 调用 `upsertGroupMemory()`
- 返回最新 `AdminGroupDetailResponse`

这样前端保存后可以直接用返回值刷新本地 state。

### 四、新增 memory 删除接口

建议新增：

- `DELETE /api/admin/groups/:folder/memory?key=topic_context`

行为：

- 校验 group 是否存在
- `key` 不能为空
- key 不存在时返回 `404`
- 删除成功后返回最新 `AdminGroupDetailResponse`

### 五、为什么不用单独 list API

因为：

- 当前 admin 选中群时本来就要请求 `getGroup`
- memory 列表天然属于群详情的一部分
- 如果再额外加 `listMemories()`，前端会多一次初始请求

因此本次优先把 memory 列表并入 `getGroup()` 返回。

## 后端实现方案

### 一、`src/admin/types.ts`

新增：

- `AdminGroupMemoryDto`
- 扩展 `AdminGroupDetailResponse.memories`

### 二、`src/admin/api.ts`

新增 helper：

- `toAdminGroupMemoryDto()`
- `buildGroupDetailResponse()` 中附带 `listGroupMemories(db, folder)`

新增 schema：

```ts
const upsertMemorySchema = z.object({
  key: z.string().trim().min(1, "memory key 不能为空"),
  keyType: z.enum(["builtin", "custom"]),
  value: z.string().trim().min(1, "memory value 不能为空"),
});
```

新增 router 方法：

- `putMemory(req)`
- `deleteMemory(req)`

错误处理约束：

- 无群：`404 group_not_found`
- key 非法：`400 invalid_request`
- 删除不存在 key：`404 memory_not_found`

### 三、`src/admin/server.ts`

新增路由：

```ts
"/api/admin/groups/:folder/memory": {
  PUT: (req) => options.api.putMemory(req),
  DELETE: (req) => options.api.deleteMemory(req),
}
```

## 前端实现方案

### 一、`src/admin/api-client.ts`

新增：

- `upsertMemory(folder, payload)`
- `deleteMemory(folder, key)`

二者都返回 `AdminGroupDetailResponse`，方便前端直接替换 `groupDetail`。

### 二、`src/admin/App.tsx`

新增 state：

- `activeSection`
- `memoryDraft`
- `isSavingMemory`
- `isDeletingMemoryKey`

建议草案结构：

```ts
type MemoryDraft = {
  mode: "create" | "edit";
  key: string;
  keyType: "builtin" | "custom";
  value: string;
};

type AdminSection = "settings" | "memory" | "files";
```

加载群时：

- `groupDetail` 中直接拿 `memories`
- 默认把表单置为空的新建态
- 默认 `activeSection = "settings"`

切换群时：

- 保留行为建议为重置到 `settings`
- 避免用户切到新群后仍停留在旧的上下文心智里

页面结构改为：

- 左侧 `group-list`
- 中间 `section-nav`
- 右侧 `section-content`

当 `activeSection = "settings"`：

- 显示当前已有的群设置页面
- 可编辑群基础信息

当 `activeSection = "memory"`：

- 显示群记忆列表
- 显示记忆编辑表单
- 支持新增 / 修改 / 删除

当 `activeSection = "files"`：

- 显示当前已有的文件浏览 + 文本编辑组合页面

点击“编辑”时：

- 将选中 memory 写入 `memoryDraft`
- `mode = "edit"`
- 锁定 `key` / `keyType`

点击“删除”时：

- 弹 `window.confirm`
- 成功后刷新 `groupDetail`
- 如果删除的是当前正在编辑的 key，则重置表单

点击“保存记忆”时：

- `mode = "create"`：允许输入 key / keyType / value
- `mode = "edit"`：沿用当前 key / keyType，只更新 value
- 保存成功后刷新 `groupDetail`
- 状态栏提示 “群记忆已保存”

### 三、样式方向

沿用当前 admin 风格，不新起视觉系统。

需要补的样式：

- `.section-nav`
- `.section-nav-button`
- `.section-content`
- `.memory-panel`
- `.memory-list`
- `.memory-item`
- `.memory-item-header`
- `.memory-badge`
- `.memory-value`
- `.memory-editor`
- `.memory-hint`

builtin / custom 可以用小 badge 区分，但不要做复杂表格。

文件浏览页里的文件列表和编辑器仍然可以维持双栏或上下布局，但这属于 `文件浏览` 页面内部布局，不再和 `群设置`、`群记忆` 同级并排。

## 测试方案

### 一、后端自动化测试

扩展 `tests/admin-api.test.ts`：

1. `getGroup()` 返回 memories
2. `putMemory()` 能新增 builtin memory
3. `putMemory()` 能新增 custom memory
4. `putMemory()` 会拒绝非法 builtin key
5. `deleteMemory()` 能删除已有 memory
6. `deleteMemory()` 删除不存在 key 时返回 `404`

### 二、前端测试策略

当前仓库没有现成的 React 组件测试基建。

因此本次先不引入新的前端测试框架，而是：

- 用 admin API 测试覆盖核心数据流
- 实现后通过本地管理页手动验证交互：
  - 进入群详情能看到 memory 列表
  - 新建成功
  - 编辑 value 成功
  - 删除成功

## 风险与权衡

1. **不支持 rename key**
   - 这是主动收敛，避免 admin API 因主键修改变复杂
2. **前端没有自动化组件测试**
   - 本次保持与仓库现状一致，先保证 API 自动化覆盖
3. **`getGroup()` 响应会变大**
   - 但单群 memory 数量通常很小，当前阶段可接受

## Todo List

### Phase 1：类型与 API
- [x] 在 `src/admin/types.ts` 中新增群记忆 DTO
- [x] 扩展 `AdminGroupDetailResponse` 以返回 memories
- [x] 在 `src/admin/api.ts` 中新增 memory upsert / delete 接口
- [x] 在 `src/admin/server.ts` 中挂载 memory 路由

### Phase 2：前端接入
- [x] 在 `src/admin/api-client.ts` 中新增 memory 请求方法
- [x] 在 `src/admin/App.tsx` 中增加二级导航
- [x] 在 `src/admin/App.tsx` 中按导航切换 `群设置 / 群记忆 / 文件浏览`
- [x] 在 `src/admin/App.tsx` 中增加 memory 列表区
- [x] 在 `src/admin/App.tsx` 中增加 memory 编辑表单
- [x] 支持新增 / 修改 / 删除 memory

### Phase 3：样式与交互
- [x] 在 `src/admin/styles.css` 中补二级导航与内容区样式
- [x] 在 `src/admin/styles.css` 中补 memory 面板样式
- [x] 在窄屏下保持布局可用
- [x] 为 builtin / custom 增加可读的视觉区分

### Phase 4：测试与验证
- [x] 扩展 `tests/admin-api.test.ts`
- [x] 验证管理页能够查看 memory
- [x] 验证管理页能够修改 memory
- [x] 验证管理页能够删除 memory
