# Admin 能力迁入 Desktop 方案

## 问题描述

当前仓库里已经有两套界面：

1. `desktop/`
   - Tauri + React 桌面端
   - 默认入口是聊天页面
   - 左侧是 group 会话列表，右侧是聊天转录与输入区
2. `src/admin/`
   - 独立的本地管理端 React 页面
   - 通过 `/api/admin/*` 管理群设置、群记忆和群目录文件

现在需要把 `src/admin` 的能力**迁入** desktop app，满足以下交互约束：

1. desktop app 默认仍然进入聊天页面
2. 左侧会话列表底部固定一个 `Admin` 入口
3. 点击 `Admin` 后切换到 admin 页面
4. 聊天页面的 group 选择、snapshot、SSE 状态在切换前后尽量保持，不因为进入 admin 页面而被清空

这次的目标不是“desktop 复用现有 admin 项目”，而是：

1. 把 admin 的功能和所需后端逻辑迁到 desktop 体系内
2. desktop 不再依赖 `src/admin/*`
3. 功能迁移完成后，删除现有 `src/admin/*` 代码
4. `src/index.ts` 也不再启动独立的 admin server

也就是说，最终结构应该是：

```text
desktop UI + desktop sidecar
  持有聊天能力
  持有群管理能力

src/admin/*
  删除
```

## 对现有项目的影响

### 一、会修改的模块

1. `desktop/src/App.tsx`
   - 增加顶层页面状态，区分 `chat` / `admin`
   - 默认仍为 `chat`
   - 在不丢失当前 `activeGroupFolder`、`snapshotsByGroup` 的前提下切换右侧工作区内容
2. `desktop/src/components/group-sidebar.tsx`
   - 在会话列表底部增加固定的 `Admin` 入口
   - 区分“选中某个聊天 group”和“进入 admin 页面”两种导航行为
3. `desktop/src/styles.css`
   - 侧边栏底部固定导航样式
   - admin 页面嵌入 desktop 工作区后的布局样式
4. `desktop/src/components/admin-page.tsx`（新增）
   - 在 desktop 中承载 admin 功能的嵌入式页面
   - 负责 settings / memory / files 三个分区
5. `desktop/src/lib/admin-client.ts`（新增）
   - 基于 `sidecarBaseUrl` 请求 desktop sidecar 上的 desktop admin API
6. `desktop/src/lib/admin-types.ts`（新增）
   - desktop admin 页面使用的 DTO 类型
   - 不再引用 `src/admin/types.ts`
7. `src/desktop/admin-api.ts`（新增）
   - 承载原 `src/admin/api.ts` 的管理接口逻辑
   - 迁入 desktop sidecar 命名空间
8. `src/desktop/admin-files.ts`（新增）
   - 承载原 `src/admin/group-files.ts` 的群目录文件读写逻辑
9. `src/desktop/admin-types.ts`（新增）
   - desktop sidecar 的 admin DTO 定义
10. `src/desktop/main.ts`
   - 在 desktop sidecar 启动时挂载 desktop 自有的 admin router
11. `src/desktop/server.ts`
   - 暴露 desktop 自有的 admin API 路由
   - 扩展 CORS 允许的方法集合，覆盖 `PATCH` / `PUT` / `DELETE`
12. `src/index.ts`
   - 删除独立 admin server 的启动逻辑
13. `tests/desktop-server.test.ts`
   - 补 desktop sidecar 暴露 admin 路由与 CORS 的测试
14. `tests/desktop-main.test.ts`
   - 补 desktop sidecar 启动后 admin API 可访问的集成测试
15. `tests/admin-api.test.ts`
   - 迁移为 desktop admin API 测试，或并入现有 desktop 测试文件
16. `tests/admin-group-files.test.ts`
   - 跟随文件能力迁移到 desktop 侧对应测试
17. `src/admin/*`
   - 功能迁移完成后全部删除

### 二、尽量不动或保持兼容的模块

1. 数据库与 group 文件结构
   - 不新增表
   - 不修改 group workspace 的磁盘布局

### 三、关键影响与约束

1. desktop sidecar 当前只允许 `GET, POST, OPTIONS`
   - admin API 需要 `PATCH, PUT, DELETE`
   - 如果不扩展，desktop 内嵌 admin 页面会直接失败
2. `src/admin` 最终需要删除
   - 所以 desktop 侧不能继续 import `src/admin/api.ts`、`src/admin/types.ts`、`src/admin/App.tsx`
   - 必须在 desktop 目录或 `src/desktop/*` 下建立新的归属
3. 当前 desktop 左侧列表语义是“聊天 group 导航”
   - 增加 `Admin` 入口后，需要明确其是“页面级导航”而不是一个伪 group

## 实现方案

### 一、总体架构决策

本次采用以下落地方式：

```text
Tauri Desktop UI
  -> 当前 desktop React 壳层
     -> Chat 页面 / Admin 页面 切换
  -> 同一个 desktop sidecar
     -> /api/desktop/*
     -> /api/desktop/admin/*
        -> src/desktop/admin-api.ts
        -> src/desktop/admin-files.ts

src/index.ts
  -> 不再启动独立 admin server

src/admin/*
  -> 删除
```

明确不采用以下方案：

1. desktop app 再额外启动一个独立 `127.0.0.1:3010` 的 admin server
2. 在 desktop 前端直接嵌一个 iframe 指向旧 `/admin`
3. 让 desktop 继续 import `src/admin/*`
4. 保留旧 admin 页面长期共存

原因：

1. 多一个本地端口会让 Tauri 生命周期更复杂
2. iframe 会让样式、状态和错误处理割裂
3. 继续依赖 `src/admin/*` 会和“迁移后删掉 admin 代码”的目标冲突
4. 旧 admin 页面长期保留会让功能归属继续分裂

因此本次会做“迁移”，不是“引用”：

1. 把 admin 的接口逻辑迁到 `src/desktop/*`
2. 把 admin 的文件系统辅助逻辑迁到 `src/desktop/*`
3. 在 `desktop/` 内重新实现 desktop 专用的 admin 页面
4. 完成后删除 `src/admin/*`

### 二、desktop 顶层页面切换

在 `desktop/src/App.tsx` 增加顶层页面状态：

```tsx
type AppView = "chat" | "admin";

const [activeView, setActiveView] = useState<AppView>("chat");
```

页面切换规则：

1. 初始值固定为 `"chat"`
2. 点击左侧某个 group
   - `setActiveGroupFolder(folder)`
   - `setActiveView("chat")`
3. 点击左侧底部 `Admin`
   - `setActiveView("admin")`
   - 不清空 `activeGroupFolder`
4. 从 admin 返回聊天时
   - 保留之前选中的 group
   - 继续使用已有 snapshot / SSE 状态

对应渲染形态：

```tsx
<GroupSidebar
  activeView={activeView}
  onSelect={(folder) => {
    setActiveGroupFolder(folder);
    setActiveView("chat");
  }}
  onOpenAdmin={() => setActiveView("admin")}
/>

{activeView === "chat" ? (
  <ChatWorkspace ... />
) : (
  <AdminPage sidecarBaseUrl={config.sidecarBaseUrl} />
)}
```

这里有一个明确决定：

1. chat 相关 state 不因为切到 admin 而 reset
2. chat 的 SSE 订阅第一版继续保持现状，不为 admin 页面额外暂停

这样可以保证从 admin 切回聊天时，当前 group 的运行态、消息流和输入状态仍然连贯。

### 三、左侧 sidebar 增加底部固定 Admin 入口

`desktop/src/components/group-sidebar.tsx` 当前结构里，`.group-list` 已经是一个滚动区域。改动方式如下：

1. 保持 `.group-list` 继续显示聊天 group
2. 在 `aside.sidebar` 底部新增固定区域 `.sidebar-footer`
3. `Admin` 按钮放在 `.sidebar-footer`，不随 group 列表滚动

结构示意：

```tsx
<aside className="sidebar">
  <header className="sidebar-header">...</header>

  <div className="group-list">
    {groups.map(...)}
  </div>

  <footer className="sidebar-footer">
    <button
      type="button"
      className={activeView === "admin" ? "sidebar-nav-button active" : "sidebar-nav-button"}
      onClick={onOpenAdmin}
    >
      Admin
    </button>
  </footer>
</aside>
```

交互约束：

1. `Admin` 不是一个 fake group，不参与 `groups.length`
2. `Admin` 激活时，聊天 group 不需要额外高亮为“当前页面”
3. 用户在 admin 页面点击某个聊天 group，直接回到 chat 页面

这符合“左侧是聊天会话列表，最下面固定一个 admin 入口”的语义。

### 四、desktop 内嵌 Admin 页面

#### 方案选择

本次不直接让 desktop import 并挂载 `src/admin/App.tsx`，而是新增：

1. `desktop/src/components/admin-page.tsx`

原因：

1. `src/admin/*` 最终要删除，不能成为长期依赖
2. `src/admin/App.tsx` 是 standalone 页面，顶层就是 `.admin-shell`
3. `src/admin/styles.css` 直接定义了全局页面样式
4. desktop 现在已经有自己的 shell，再套一个完整 admin shell 会出现双层外壳和样式污染

因此 desktop 内只迁移 admin 的能力结构，不直接复用其整页容器。

#### 嵌入式布局

admin 页面在 desktop 右侧工作区内渲染，推荐结构：

```text
workspace
  ├─ admin-page-header
  └─ admin-page-body
       ├─ admin-groups-panel
       ├─ admin-section-nav
       └─ admin-section-content
```

也就是：

1. desktop 左侧依然保留聊天 group sidebar
2. desktop 右侧显示 admin 自己的群管理内容
3. admin 页面内部仍保留：
   - 目标群列表
   - 设置 / 记忆 / 文件 三个 section

这样做的原因是：

1. 左侧全局 sidebar 负责“桌面 app 一级导航”
2. admin 页面内部的群列表负责“被管理对象选择”

两者职责不同，不冲突。

#### admin 页面状态

`desktop/src/components/admin-page.tsx` 将沿用 admin 原有功能结构，但状态和界面都归 desktop 自己维护：

1. `groups`
2. `profiles`
3. `selectedFolder`
4. `activeSection`
5. `groupDetail`
6. `settingsDraft`
7. `memoryDraft`
8. `directory`
9. `openFile`
10. `editorValue`
11. `statusText`

但界面 className 和外层布局会改成 desktop 专用命名，避免和旧 admin 页面的 className 混用。

### 五、desktop 端 admin API client 与类型归属

新增 `desktop/src/lib/admin-client.ts`，直接面向 desktop sidecar 的 admin API：

```ts
export class DesktopAdminClient {
  constructor(private readonly baseUrl: string) {}

  listGroups() {
    return request(`${this.baseUrl}/api/desktop/admin/groups`);
  }
}
```

实现要求：

1. API 协议延续现有 admin 能力，但客户端实现放在 desktop 自己目录下
2. desktop 中所有 admin 请求都走 `config.sidecarBaseUrl`
3. 错误解析行为与现有 admin client 保持一致，便于沿用后端错误文案

类型复用优先级：

1. 不再引用 `src/admin/types.ts`
2. 将 DTO 明确迁到 desktop 归属：
   - 前端类型放 `desktop/src/lib/admin-types.ts`
   - sidecar DTO 放 `src/desktop/admin-types.ts`
3. 如果两边确实需要共享，再抽成新的 desktop 共享位置，但不能留在 `src/admin/*`

### 六、把 admin 后端能力迁到 desktop sidecar

#### 后端迁移位置

把以下文件能力迁出 `src/admin/*`：

1. `src/admin/api.ts` -> `src/desktop/admin-api.ts`
2. `src/admin/group-files.ts` -> `src/desktop/admin-files.ts`
3. `src/admin/types.ts` -> `src/desktop/admin-types.ts`

迁移后的要求：

1. 文件职责保持不变，但归属改成 desktop
2. import 路径统一切到 `src/desktop/*`
3. 对外不再存在独立 admin server

#### 启动层

在 `src/desktop/main.ts` 中，desktop sidecar 初始化时创建 desktop 自有 admin router：

```ts
import { createDesktopAdminApiRouter } from "./admin-api";

const adminApi = createDesktopAdminApiRouter(db, { rootDir });

const server = startDesktopServer({
  api,
  adminApi,
  hostname: options.hostname,
  port: options.port,
});
```

#### 服务层

扩展 `src/desktop/server.ts`：

1. `startDesktopServer` 增加 `adminApi` 参数
2. 注册以下路由：
   - `GET /api/desktop/admin/groups`
   - `GET /api/desktop/admin/groups/:folder`
   - `PATCH /api/desktop/admin/groups/:folder`
   - `PUT /api/desktop/admin/groups/:folder/memory`
   - `DELETE /api/desktop/admin/groups/:folder/memory`
   - `GET /api/desktop/admin/groups/:folder/files`
   - `GET /api/desktop/admin/groups/:folder/file`
   - `PUT /api/desktop/admin/groups/:folder/file`
   - `POST /api/desktop/admin/groups/:folder/file`
   - `POST /api/desktop/admin/groups/:folder/folder`

注意：

1. desktop sidecar 不需要暴露旧 `/admin` HTML 页面
2. admin 能力已经属于 desktop，所以 API 也收归 `/api/desktop/admin/*`

#### CORS 扩展

当前 `createCorsHeaders()` 只允许：

```text
GET, POST, OPTIONS
```

本次必须改成：

```text
GET, POST, PATCH, PUT, DELETE, OPTIONS
```

否则管理端的保存设置、保存记忆、删除记忆、文件写入都会被浏览器/Tauri WebView 拦截。

### 七、删除旧 admin 代码

本轮的原则是：

1. admin 能力迁入 desktop 后，删除旧 `src/admin/*`
2. `src/index.ts` 不再启动 `startAdminServer(...)`
3. 原 `tests/admin-api.test.ts`、`tests/admin-group-files.test.ts` 迁移或重写到 desktop 侧测试

建议删除范围：

1. `src/admin/App.tsx`
2. `src/admin/main.tsx`
3. `src/admin/index.html`
4. `src/admin/styles.css`
5. `src/admin/api-client.ts`
6. `src/admin/api.ts`
7. `src/admin/group-files.ts`
8. `src/admin/types.ts`
9. `src/admin/server.ts`

这是一个刻意的工程取舍：

1. 本次需求核心不是双端共存，而是功能归并
2. 保留旧 admin 只会让归属继续模糊
3. 一次迁到 desktop 名下，后续维护路径最清晰

## Todo List

- [x] 在 `desktop/src/App.tsx` 增加 `chat/admin` 顶层页面状态，默认进入聊天页
- [x] 调整 `desktop/src/components/group-sidebar.tsx`，在会话列表底部增加固定 `Admin` 入口
- [x] 更新 `desktop/src/styles.css`，支持 sidebar 底部固定区域与 admin 页面嵌入式布局
- [x] 新增 `desktop/src/lib/admin-client.ts`，通过 `sidecarBaseUrl` 访问 `/api/desktop/admin/*`
- [x] 新增 `desktop/src/lib/admin-types.ts`，承载 desktop 前端所需 admin DTO
- [x] 新增 `desktop/src/components/admin-page.tsx`，实现群设置、群记忆、文件浏览/编辑能力
- [x] 将 `src/admin/api.ts` 迁到 `src/desktop/admin-api.ts`
- [x] 将 `src/admin/group-files.ts` 迁到 `src/desktop/admin-files.ts`
- [x] 将 `src/admin/types.ts` 迁到 `src/desktop/admin-types.ts`
- [x] 在 `src/desktop/main.ts` 中创建 desktop 自有 `adminApi` 并注入 sidecar
- [x] 扩展 `src/desktop/server.ts`，把 `/api/desktop/admin/*` 路由挂到 desktop sidecar
- [x] 扩展 desktop sidecar 的 CORS method 白名单，覆盖 `PATCH/PUT/DELETE`
- [x] 更新 `src/index.ts`，删除独立 admin server 启动逻辑
- [x] 迁移或重写 admin 相关测试到 desktop 侧，更新 `tests/desktop-server.test.ts`
- [x] 迁移或重写 admin 相关测试到 desktop 侧，更新 `tests/desktop-main.test.ts`
- [x] 删除旧 `src/admin/*` 与不再需要的旧 admin 测试文件
- [x] 本地执行相关测试，确认原有 desktop API 与新并入的 admin API 都通过
