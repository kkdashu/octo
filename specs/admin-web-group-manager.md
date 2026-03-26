# 群管理网页程序

## 问题描述

当前管理群能力只能通过“在主群里聊天 + 让 Agent 调工具”完成，存在几个明显问题：

1. 群列表和群配置不可视化，查看和修改都依赖自然语言指令，效率低且容易出错。
2. 群目录内文件只能靠命令式操作或聊天间接修改，缺少稳定的查看、编辑、新增入口。
3. 现在没有一个明确的管理端来集中处理群信息、AI 引擎切换、群内指令文件维护等日常运维工作。

这次需要基于 `bun + react` 增加一个网页管理程序，满足以下核心能力：

- 查看所有已注册群列表
- 查看并修改群信息
- 修改群目录内文件内容
- 新增文件
- 查看文件内容

同时需要避免把群配置和文件操作能力直接裸露到公网，因此管理端第一版只允许通过 `localhost` 访问，不增加额外鉴权流程。

## 对现有项目的影响

### 受影响的代码与资源

- `package.json`
  用于新增 React 前端依赖与管理端相关脚本（如需要）。
- `src/index.ts`
  在现有飞书 websocket 运行时之外，增加本地管理端 HTTP 服务启动。
- `src/channels/feishu.ts`
  仅保留飞书 websocket 消息接收、消息发送、群列表获取等职责；本次不再把管理端耦合到该模块。
- `src/db.ts`
  增加群信息更新 helper，避免在 HTTP handler 里直接写 SQL。
- `src/runtime/profile-config.ts`
  复用现有 profile 列表能力，为网页端提供可选 AI 引擎列表。
- `src/channels/types.ts`
  视实现方式，可能需要扩展通道接口或拆分出 webhook handler 类型。
- `src/admin/*`
  新增管理端前后端代码，包括 HTML 入口、React 页面、API 处理、文件系统服务。
- `tests/*`
  新增管理端 API、文件路径校验、群信息更新相关测试。

### 数据与运行时影响

- 不新增数据库表。
- `registered_groups` 表结构保持不变，但需要新增“更新群元数据”的读写接口。
- 新增一个仅监听 `127.0.0.1` 的管理端 HTTP 服务，负责：
  - 管理端 HTML 路由
  - 管理端 JSON API 路由
- 飞书消息接收继续走当前 websocket 链路，不依赖管理端 HTTP 服务。

### 风险与约束

1. 管理端如果绑定到 `0.0.0.0` 或复用现有对外端口，就会把群配置和文件编辑能力暴露出去，因此必须显式绑定 `127.0.0.1`。
2. 群文件操作如果不做路径约束，容易出现目录穿越，误改仓库其他文件。
3. 群目录里既有正常文件，也可能有 `.claude/skills` 这类隐藏目录；文件树展示需要允许查看，但必须限制在目标群目录之内。

## 实现方案

### 总体设计

采用一个单独的本地 Bun HTTP 服务：

- `/admin`：管理网页入口
- `/api/admin/*`：管理端 API

前端使用 React 挂载到 `/admin`，后端继续使用 Bun 原生路由和文件系统 API。这样可以直接参考 `docs/bun/fullstack.md` 的 HTML route + API route 方式，不引入额外框架。

这个服务只监听 `127.0.0.1`，不对局域网或公网开放。

架构目标：

```text
Browser
  → /admin
    → React SPA
      → /api/admin/groups
      → /api/admin/groups/:folder
      → /api/admin/groups/:folder/files
      → /api/admin/groups/:folder/file

Feishu
  → Lark WSClient
    → EventDispatcher
      → FeishuChannel.handleMessageEvent
```

### 1. 新增本地管理端 HTTP 服务，不复用飞书入口

当前项目里飞书消息接收已经通过 `lark.WSClient` 工作，用户也已经把 webhook HTTP 启动逻辑注释掉了。因此这次不再设计“统一服务承载飞书 webhook 和管理端”，而是直接新增一个本地管理端服务。

本次调整为：

1. `FeishuChannel` 继续保留消息解析、消息发送、群列表获取等职责。
2. 新增一个独立的 `src/admin/server.ts` 或 `src/http-admin.ts`。
3. 在该模块中调用 `Bun.serve()`，只注册管理端页面和 API。
4. 服务端监听地址明确写死或配置为 `hostname: "127.0.0.1"`，端口使用单独环境变量，例如 `ADMIN_PORT`，默认可取 `3010`。

建议新增文件：

- `src/admin/server.ts`
- `src/admin/api.ts`

示意代码：

```ts
// src/admin/server.ts
import adminHtml from "./admin/index.html";

export function startAdminServer(deps: {
  hostname?: string;
  port: number;
  adminApi: AdminApiRouter;
}) {
  return Bun.serve({
    hostname: deps.hostname ?? "127.0.0.1",
    port: deps.port,
    development: true,
    routes: {
      "/admin": adminHtml,
      "/api/admin/groups": {
        GET: req => deps.adminApi.listGroups(req),
      },
    },
  });
}
```

这样管理端与飞书接收完全解耦，也符合“只能通过 localhost 访问”的要求。

### 2. 通过 localhost 访问限制替代鉴权

因为这次明确要求“不加鉴权，但只能通过 localhost 访问”，第一版不增加 token 登录、cookie session 或用户体系。

约定：

1. 管理端服务必须使用 `hostname: "127.0.0.1"`，不能绑定 `0.0.0.0`。
2. 管理端页面不做登录页，直接进入应用。
3. 如需配置端口，可增加：

```bash
ADMIN_PORT=3010
```

启动后访问形态类似：

```text
http://127.0.0.1:3010/admin
```

这能满足本机管理需求，也不会影响飞书 websocket 接收。

### 3. 群信息管理 API

#### 可编辑字段

网页端第一版只允许修改这些字段：

- `name`
- `agent_provider`
- `trigger_pattern`
- `requires_trigger`

这些字段都已经存在于当前数据模型中，且不会引入目录迁移问题。

以下字段只读展示，不允许网页直接修改：

- `jid`
- `folder`
- `channel_type`
- `is_main`
- `added_at`

原因：

- 修改 `folder` 会涉及目录重命名、session 迁移、任务引用修复，复杂度明显更高，不适合放进本次第一版。
- 修改 `jid` / `channel_type` 会影响通道映射，风险太大。
- `is_main` 变更属于更高层运维动作，不应混进普通编辑表单。

#### 后端接口

建议新增或整理以下接口：

- `GET /api/admin/groups`
  返回群列表和 profile 列表，供左侧导航和 AI 引擎下拉框使用。
- `GET /api/admin/groups/:folder`
  返回单个群详情。
- `PATCH /api/admin/groups/:folder`
  更新群信息。

返回结构示意：

```json
{
  "group": {
    "jid": "oc_xxx",
    "name": "测试群",
    "folder": "feishu_oc_xxx",
    "channelType": "feishu",
    "triggerPattern": "@octo",
    "requiresTrigger": true,
    "isMain": false,
    "agentProvider": "codex",
    "addedAt": "2026-03-24T00:00:00.000Z"
  },
  "availableProfiles": [
    { "profileKey": "claude", "model": "claude-sonnet-4-6" },
    { "profileKey": "codex", "model": "gpt-5.4" }
  ]
}
```

`src/db.ts` 需要新增一个更新 helper，避免散落 SQL：

```ts
export function updateGroupMetadata(
  db: Database,
  folder: string,
  patch: {
    name: string;
    triggerPattern: string;
    requiresTrigger: boolean;
    agentProvider: string;
  },
) {
  db.query(`
    UPDATE registered_groups
    SET name = $name,
        trigger_pattern = $triggerPattern,
        requires_trigger = $requiresTrigger,
        agent_provider = $agentProvider
    WHERE folder = $folder
  `).run({
    folder,
    name: patch.name,
    triggerPattern: patch.triggerPattern,
    requiresTrigger: patch.requiresTrigger ? 1 : 0,
    agentProvider: patch.agentProvider,
  });
}
```

同时在 API 层校验 `agentProvider` 必须出现在 `loadAgentProfilesConfig().profiles` 中，避免保存非法 profile key。

### 4. 群目录文件管理 API

#### 支持范围

本次只做“文本文件管理”，能力包括：

- 查看群目录文件树
- 查看文本文件内容
- 修改已有文本文件
- 新增文本文件
- 新增文件夹（便于创建嵌套文件）

本次先不做：

- 删除文件
- 重命名文件
- 上传二进制文件
- 二进制预览
- Git diff / 历史版本管理

这样可以把第一版范围压在“运维可用”而不是“全功能文件管理器”。

#### 路径约束

所有文件操作都必须限制在 `groups/<groupFolder>` 内。

建议新增文件系统 service：

- `src/admin/group-files.ts`

核心校验逻辑：

```ts
import { resolve, relative } from "node:path";

export function resolveGroupPath(groupFolder: string, targetPath = "."): string {
  const groupRoot = resolve("groups", groupFolder);
  const absolute = resolve(groupRoot, targetPath);
  const rel = relative(groupRoot, absolute);

  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes group root");
  }

  return absolute;
}
```

接口建议：

- `GET /api/admin/groups/:folder/files?path=.`
  返回目录内容列表。
- `GET /api/admin/groups/:folder/file?path=CLAUDE.md`
  返回文本文件内容。
- `PUT /api/admin/groups/:folder/file`
  写入已有文件，body 包含 `path` 和 `content`。
- `POST /api/admin/groups/:folder/file`
  新建文件，body 包含 `path`、`content`、可选 `createParents`。
- `POST /api/admin/groups/:folder/folder`
  新建目录。

文件读取规则：

1. 若目标是目录，返回 `400`。
2. 若文件不存在，返回 `404`。
3. 若文件内容不是合法 UTF-8 文本，返回 `415` 或明确错误，不在第一版尝试兼容二进制。
4. 若文件过大（例如超过 1MB），返回错误，避免网页一次性加载超大文本。

目录列表返回示意：

```json
{
  "path": ".",
  "entries": [
    { "name": ".claude", "path": ".claude", "kind": "directory" },
    { "name": "CLAUDE.md", "path": "CLAUDE.md", "kind": "file", "size": 2405 }
  ]
}
```

### 5. React 管理端页面结构

参考 `docs/bun/fullstack.md`，在本地管理端服务中使用 HTML route + TSX 入口：

- `src/admin/index.html`
- `src/admin/main.tsx`
- `src/admin/App.tsx`
- `src/admin/styles.css`
- `src/admin/api-client.ts`
- `src/admin/types.ts`

页面建议采用双栏布局：

1. 左侧群列表
   - 展示群名、folder、当前 AI 引擎
   - 支持点击切换当前群
2. 右侧详情区
   - 群信息表单
   - 文件树
   - 文件编辑器

交互流程：

1. 打开 `http://127.0.0.1:<ADMIN_PORT>/admin`
2. 页面直接加载群列表
3. 点击某个群，右侧加载该群详情和根目录文件树
4. 点击文件后展示内容，可编辑并保存
5. 点击“新建文件/文件夹”后提交 API 并刷新目录

组件边界建议：

```tsx
<App>
  <AuthGate>
  <GroupSidebar />
  <GroupSettingsPanel />
  <GroupFileTree />
  <FileEditorPanel />
</App>
```

其中：

- `GroupSettingsPanel` 负责群信息表单和保存
- `GroupFileTree` 负责目录浏览和新建文件/目录
- `FileEditorPanel` 只处理文本文件查看与保存

第一版不引入复杂编辑器库，先使用 `textarea`。这样依赖更少，也更适合 Bun 原生打包。

### 6. 统一类型与数据转换

后端数据库字段是 snake_case，前端更适合 camelCase。建议在 API 层统一做一次转换，不把原始 SQLite 行对象直接暴露给 React。

例如：

```ts
function toAdminGroupDto(group: RegisteredGroup) {
  return {
    jid: group.jid,
    name: group.name,
    folder: group.folder,
    channelType: group.channel_type,
    triggerPattern: group.trigger_pattern,
    requiresTrigger: group.requires_trigger === 1,
    isMain: group.is_main === 1,
    agentProvider: group.agent_provider,
    addedAt: group.added_at,
  };
}
```

这样可以减少前端大量判断 `=== 1` / `=== 0`，也能让接口更稳定。

### 7. 测试方案

必须为管理端新增测试，至少覆盖以下内容：

#### 数据与业务层

- `updateGroupMetadata()` 能正确更新 name / trigger_pattern / requires_trigger / agent_provider
- 非法 profile key 在 API 层被拒绝

#### 文件系统层

- 正常读取群目录内文件
- `../` 目录穿越会被拒绝
- 读取目录当文件时报错
- 写入群目录外路径时报错
- 创建文件和文件夹成功

#### HTTP/API 层

- `GET /api/admin/groups` 返回群列表和 profiles
- `PATCH /api/admin/groups/:folder` 成功更新群信息
- 读写文件接口返回正确状态码
- 管理端服务监听地址为 `127.0.0.1`

建议测试文件：

- `tests/admin-api.test.ts`
- `tests/admin-group-files.test.ts`

如果 HTTP 路由不方便直接起真实 server，可把 handler 抽成纯函数后直接调用，保持测试稳定且快速。

## 文件级改动计划

### 新增文件

- `src/admin/server.ts`
- `src/admin/index.html`
- `src/admin/main.tsx`
- `src/admin/App.tsx`
- `src/admin/styles.css`
- `src/admin/api.ts`
- `src/admin/api-client.ts`
- `src/admin/group-files.ts`
- `src/admin/types.ts`
- `tests/admin-api.test.ts`
- `tests/admin-group-files.test.ts`

### 修改文件

- `package.json`
- `src/index.ts`
- `src/db.ts`
- `env.example`

## 非目标

这次规格里明确不包含以下内容：

- 群目录删除/重命名
- 群 folder 重命名
- 群 jid 修改
- 群主从切换
- 二进制文件上传与预览
- 多用户登录体系

这些需求后续可以独立做二期，不和本次“先交付可用管理端”混在一起。

## Todo List

- [x] 新增仅绑定 `127.0.0.1` 的管理端 HTTP 服务，并在 `src/index.ts` 中启动
- [x] 在 `src/db.ts` 中增加群信息更新 helper，并补充相应测试
- [x] 新增管理端群列表、群详情、群信息更新 API
- [x] 新增群目录文件树、文件读取、文件写入、新建文件、新建目录 API
- [x] 为文件系统操作补齐路径穿越与文本文件限制校验
- [x] 使用 React 搭建 `/admin` 页面，完成群列表、群信息表单、文件树、文件编辑器
- [x] 安装并接入 `react`、`react-dom` 依赖，确保 Bun 全栈路由可正常打包
- [x] 新增管理端 API 与文件系统测试，并运行相关测试
