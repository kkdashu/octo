# Pi Runtime 与 Profile 路由

## 目标

Octo 当前只保留一个运行时实现：`PiProvider`。`profile_key` 的作用只是选择模型线路和上游接口，不再表示 SDK 类型。

## 主链路

```text
消息进入
  → Router / GroupRuntimeManager / FeishuGroupAdapter
    → 读取 workspaces.profile_key
    → resolveAgentProfile(profileKey)
    → PiProvider.startSession()
      → createAgentSession(pi-mono)
        → builtin tools
        → adaptOctoTools()
        → createPiMcpExtensionBundle()
```

关键文件：

- `src/group-queue.ts`
- `src/providers/pi.ts`
- `src/runtime/profile-config.ts`
- `src/providers/pi-tool-adapter.ts`
- `src/providers/pi-mcp-extension.ts`

## Profile 语义

Profile 配置定义了：

- `profileKey`
- `apiFormat`
- `upstreamApi`
- `baseUrl`
- `apiKeyEnv`
- `model`
- `provider`
- `codingPlanEnabled`

`src/runtime/profile-config.ts` 负责：

- 加载 profile 配置文件
- 对不存在的 key 回退到 `defaultProfile`
- 校验默认 profile 是否存在
- 从环境变量读取真实 API key
- 对 Moonshot 线路做兼容修正

`PiProvider` 会把 profile 映射成 Pi 所需的 API 类型：

- `anthropic` → `anthropic-messages`
- `openai + responses` → `openai-responses`
- `openai + chat_completions` → `openai-completions`

## Session 语义

数据库中的 `chats.session_ref` 保存的是 Pi 本地 session 文件引用，而不是远端 provider 的 session ID。

相关逻辑：

- `src/providers/pi-session-ref.ts`：创建、恢复、解析 session ref
- `src/kernel/group-runtime-manager.ts`：按 Chat 恢复与切换 session
- `src/runtime/feishu-group-adapter.ts`：按 Chat 恢复与持久化 session
- `src/db.ts`：统一维护 `chats.session_ref` 与兼容层 `sessions.session_ref`

行为约定：

- 切 profile 不自动删除 session ref
- 显式清上下文时才使用 `clear_session`
- 若数据库里保存的 session ref 已失效，启动时会自动丢弃

## 工作区与技能

每个 Workspace 目录统一采用：

```text
workspaces/<folder>/
  AGENTS.md
  .pi/
    skills/
    sessions/
```

相关代码：

- `src/index.ts`：创建 `AGENTS.md`、同步 system skills、迁移 legacy workspace
- `src/kernel/group-runtime-manager.ts`：按 Chat 绑定 session 与 branch
- `src/tools.ts`：curated skill 安装目标为 `.pi/skills`

启动时的迁移辅助只做复制：

- `CLAUDE.md` → `AGENTS.md`
- `.claude/skills` → `.pi/skills`

运行时不会继续读取 `.claude/skills`。

## Tool / API 命名

Pi-native 命名统一使用 profile 语义：

- `switch_profile`
- `profileKey`
- `profile_key`

相关文件：

- `src/tools.ts`
- `src/admin/api.ts`
- `src/admin/types.ts`
- `src/admin/App.tsx`

## 外部 MCP

外部 MCP 配置由 `src/runtime/external-mcp-config.ts` 读取，再由 `src/providers/pi-mcp-extension.ts` 转成 Pi extension。

这意味着：

- MCP 以 Pi 的 extension 方式注入，不再依赖 Claude SDK 兼容层
- tool name 统一映射为 `mcp__<server>__<tool>`
- 可按群技能决定是否启用某些 MCP server

`pdf-to-markdown` 就是当前的一个例子：只有当 Workspace 目录存在 `.pi/skills/pdf-to-markdown/SKILL.md` 时，`markitdown` MCP 才会被注入。
