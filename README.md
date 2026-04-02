# Octo

多群组 AI Agent 编排系统。现在底层统一只使用 Claude Agent SDK，群组间通过 `agent_provider` 选择不同的模型线路 profile，而不是切换不同 SDK。

## 特性

- 统一 runtime：所有群组都走 `ClaudeProvider`
- 多 profile 路由：`claude`、`codex`、`kimi`、`kimi-cli`、`minimax`
- 多群隔离：独立工作目录、独立 session、独立技能
- 统一工具：全部通过 Claude SDK 进程内 MCP 接入
- MiniMax 文生图：通过 `generate_image` 生成本地图片，再复用 `send_image` 发送
- 会话恢复：群组切换 profile 不再清 session
- 群级长期记忆：数据库持久化的 group memory 会在新 session 和定时任务启动时自动注入
- 定时任务与技能安装：沿用现有工具体系

## 架构

```text
飞书群消息
  → Channel / Router
    → GroupQueue
      → resolveAgentProfile(group.agent_provider)
      → ClaudeProvider
        → Claude Agent SDK
          → Anthropic 直连
          或
          → 本地 OpenAI 兼容 proxy
            → OpenAI / 其他 OpenAI 兼容上游
```

## 快速开始

```bash
bun install
cp env.example .env
# 编辑 .env，填入飞书凭证和各线路 API Key（Anthropic / OpenAI / Moonshot / MiniMax）

bun run start
```

默认会读取：

1. `AGENT_PROFILES_PATH` 指向的配置文件
2. 若未设置，则尝试 `config/agent-profiles.json`
3. 若仍不存在，则回退到 `config/agent-profiles.example.json`

外部 MCP 配置会按以下顺序读取：

1. `EXTERNAL_MCP_CONFIG_PATH` 指向的配置文件
2. 若未设置，则尝试 `config/external-mcp.json`
3. 若仍不存在，则回退到 `config/external-mcp.example.json`

Moonshot/Kimi 线路说明：

- `kimi`：走 `https://api.moonshot.cn/anthropic`
- `kimi-cli`：走 `https://api.kimi.com/coding`
- 这两条线路都以 Anthropic 兼容模式直连 Claude Agent SDK，不经过本地 OpenAI 兼容 proxy

MiniMax 线路说明：

- `minimax`：走 `https://api.minimaxi.com/anthropic`
- `minimax` 以 Anthropic 兼容模式直连 Claude Agent SDK，不经过本地 OpenAI 兼容 proxy
- `generate_image` 工具会直接调用 `https://api.minimaxi.com/v1/image_generation`
- 文生图工具与当前群 `agent_provider` 无关，只要求配置了 `MINIMAX_API_KEY`
- 生成后的图片会保存到当前群目录 `.generated/images/`，再由 `send_image` 发送
- 本地 OpenAI 兼容 proxy 只用于真正的 OpenAI 格式 profile，例如 `codex`

模型交互日志：

- 现有应用日志保持不变，仍写入 `${LOG_DIR}/octo-YYYY-MM-DD.log`
- 新增完整模型交互日志，写入 `${LOG_DIR}/model/<group-folder>/`
- 文件名格式为 `octo-model-YYYY-MM-DD(.N).jsonl`
- 每个 group 独立按天分割；同日单文件超过 `80MB` 时自动切到续号文件

## 切换线路

在主群里使用：

- `list_profiles`：查看当前可用 profile
- `switch_provider`：把目标群切到指定 profile

或直接修改数据库：

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_provider = 'kimi-cli' WHERE folder = 'xxx';"
```

这里的 `agent_provider` 现在表示 profile key，不再表示底层 SDK 类型，例如可以切到 `minimax`。

## 群记忆

可在群内通过以下工具维护长期记忆：

- `remember_group_memory`
- `list_group_memory`
- `forget_group_memory`
- `clear_group_memory`

内置 key 包括：

- `topic_context`
- `response_language`
- `response_style`
- `interaction_rule`

当内置 key 不够用时，也支持使用仅包含小写字母和下划线的 custom key，例如 `study_goal`、`difficulty_level`。

群记忆存储在 SQLite `group_memories` 表中，只在新 session 启动时注入；active session 不做热更新。定时任务走统一的 `GroupQueue.enqueue()` 链路，因此也会复用同一份群记忆。

## 配置文件

示例见 [config/agent-profiles.example.json](/Users/wmeng/work/kkdashu/octo/config/agent-profiles.example.json)。

```json
{
  "defaultProfile": "claude",
  "profiles": {
    "claude": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "model": "claude-sonnet-4-6"
    },
    "codex": {
      "apiFormat": "openai",
      "upstreamApi": "responses",
      "baseUrl": "https://api.openai.com",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4"
    },
    "kimi": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.moonshot.cn/anthropic",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5",
      "provider": "moonshot"
    },
    "kimi-cli": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.kimi.com/coding",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "model": "kimi-k2.5",
      "codingPlanEnabled": true,
      "provider": "moonshot"
    },
    "minimax": {
      "apiFormat": "anthropic",
      "baseUrl": "https://api.minimaxi.com/anthropic",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "model": "MiniMax-M2.7",
      "provider": "minimax"
    }
  }
}
```

外部 MCP 示例见 [config/external-mcp.example.json](/Users/wmeng/work/kkdashu/octo/config/external-mcp.example.json)。

## PDF 转 Markdown

如果你希望某些群支持“接收 PDF，转成 Markdown，再把 `.md` 文件发回飞书”，需要同时完成两步：

1. 在运行 Octo 的机器上安装 `markitdown-mcp`
2. 只给目标群安装 curated skill `pdf-to-markdown`

### 安装 MarkItDown MCP

可任选一种方式安装：

```bash
pip install markitdown-mcp
```

或：

```bash
uv tool install markitdown-mcp
```

### 配置外部 MCP

新建 `config/external-mcp.json`，例如：

```json
{
  "servers": {
    "markitdown": {
      "enabled": true,
      "command": "markitdown-mcp"
    }
  }
}
```

如果你更希望按需拉起，也可以改成 `uvx`：

```json
{
  "servers": {
    "markitdown": {
      "enabled": true,
      "command": "uvx",
      "args": ["markitdown-mcp"]
    }
  }
}
```

### 按群启用

不要把这个能力做成系统 skill。当前实现是按群 gated 的：

1. 在目标群里调用 `install_curated_skill`
2. 参数传 `skillName = "pdf-to-markdown"`
3. 该群后续新开的 Claude session 会注入 `markitdown` MCP
4. 未安装该 skill 的群不会看到也不会拿到这组工具权限

启用后，群里用户把 PDF 发给机器人，并提出“转成 Markdown 发回来”这类请求时，agent 会：

1. 读取消息里的本地文件链接与 `可读路径`
2. 调用 `mcp__markitdown__convert_to_markdown`
3. 将结果保存到 `groups/<group-folder>/.generated/documents/`
4. 通过现有 `send_message` 的 Markdown 文件链接格式把 `.md` 文件发回飞书

## 技术栈

- Runtime: Bun
- Database: SQLite (`bun:sqlite`)
- Agent runtime: `@anthropic-ai/claude-agent-sdk`
- IM: 飞书
- Validation: `zod`

## 文档

- [项目文档](/Users/wmeng/work/kkdashu/octo/docs/octo.md)
- [统一运行时说明](/Users/wmeng/work/kkdashu/octo/docs/multi-agent-provider.md)
