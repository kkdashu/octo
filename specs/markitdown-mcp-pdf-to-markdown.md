# 按群通过 Skill 启用 MarkItDown MCP，将 PDF 转 Markdown 并发回飞书

## 问题说明

当前项目已经支持：

1. 接收飞书文件消息，并把文件下载到本地工作区。
2. 通过 `send_message` 的 Markdown 文件链接语法，把本地文件重新发回飞书。

但当前 agent 仍然缺少“把 PDF 文件转换成 Markdown”的能力。

用户现在的目标不是“全局给所有群增加文档转换能力”，而是：

1. 写一个 skill
2. 只有安装了这个 skill 的群，才拥有该能力
3. 在这些群里，机器人可以把收到的 PDF 转 Markdown，再发回飞书

这意味着本次设计要同时满足两个约束：

1. **能力存在**：Claude session 能调用 `markitdown-mcp`
2. **按群隔离**：没有安装该 skill 的群，不应该看到或使用这个能力

如果只做 skill 文案，而把 `markitdown` MCP 全局注入给所有群，那么虽然“更可能”只有装了 skill 的群会去调用，但实际上所有群都具备能力，这不符合“添加了这个 skill 的群才有这个能力”的要求。

因此本次的真正目标应当是：

1. 新增一个 curated skill，例如 `pdf-to-markdown`
2. 目标群安装该 skill 后，后端在启动该群 session 时才注入 `markitdown` MCP
3. agent 在该群中才可以调用 `convert_to_markdown(file://...)`
4. 再通过现有 `send_message` 把 `.md` 文件发回飞书

本次明确不做的事：

- 不把 MarkItDown 重写成仓库内置 JS 转换器
- 不把 `convert_to_markdown` 再包装成新的业务工具
- 不把该能力全局开放给所有群
- 不自动对所有收到的 PDF 一律立即转换
- 不处理 DOCX / PPTX / XLSX 等其它格式的精细策略，第一期主流程先围绕“PDF 转 Markdown 并发回飞书”

## 外部能力调研结论

基于 `markitdown-mcp` 官方资料，可以确认：

1. `markitdown-mcp` 是一个标准 MCP server。
2. 它支持：
   - STDIO
   - HTTP / SSE
3. 它暴露工具：

```text
convert_to_markdown(uri)
```

4. `uri` 支持：
   - `http:`
   - `https:`
   - `file:`
   - `data:`

这意味着，对当前项目最自然的接法不是业务层重写转换器，而是：

1. 把 `markitdown-mcp` 作为外部 MCP server 接入 Claude SDK
2. 对本地 PDF 使用 `file://` URI
3. 由 agent 直接调用 `mcp__markitdown__convert_to_markdown`

## 对现有项目的影响

预计受影响文件：

- `src/providers/types.ts`
- `src/providers/claude.ts`
- `src/group-queue.ts`
- `src/tools.ts`
- `src/runtime/` 下新增外部 MCP 配置读取模块
- `README.md`
- `config/external-mcp.example.json`
- `skills/curated/pdf-to-markdown/SKILL.md`
- `tests/providers.test.ts`
- 可能新增 `tests/external-mcp-config.test.ts`

行为变化：

1. `markitdown-mcp` 不会自动对所有群启用。
2. 只有安装了 `pdf-to-markdown` curated skill 的群，session 才会附加 `markitdown` MCP server。
3. 这些群的 agent 可以调用：

```text
mcp__markitdown__convert_to_markdown
```

4. agent 可以把转换结果保存到当前 group 目录，再用现有 `send_message` 的 Markdown 文件语法发回飞书。

不变项：

- 不新增新的飞书发送协议
- 不改现有文件接收与发送主链路
- 不改变 `send_image` / `send_message` 的既有语义
- 没安装 skill 的群，其它工具与行为不受影响

## 关键设计原则

本次方案必须同时满足两个层次：

### 1. Skill 层：行为引导

skill 用来告诉 agent：

1. 什么时候该做 PDF 转 Markdown
2. 应该如何调用 `markitdown` MCP
3. 应该把结果保存到哪里
4. 应该如何用 `send_message` 发回飞书

### 2. Runtime 层：能力门控

真正决定“群是否有这个能力”的，不是 skill 文本，而是 session 注入的 MCP 能力集。

也就是说：

- **只有 skill，没有 runtime gating**：所有群实际上都能用
- **只有 runtime gating，没有 skill**：agent 不容易稳定正确使用

因此本次必须两层一起做：

1. 安装 skill 的群，才注入 `markitdown` MCP
2. 安装 skill 的群，也会获得对应的行为说明

## 采用方案

采用以下方案：

1. 新增 curated skill：

```text
skills/curated/pdf-to-markdown/SKILL.md
```

2. 群通过现有工具 `install_curated_skill` 安装该 skill。
3. `GroupQueue` 在启动 session 时，检查该群是否已安装此 skill。
4. 若已安装，则把 `markitdown` MCP server 注入 `SessionConfig.externalMcpServers`。
5. `ClaudeProvider` 合并外部 MCP server，并放行 `mcp__markitdown__*`。
6. agent 调用 MCP 转换 PDF，并将 Markdown 文件发回飞书。

## 实现方案

### 1. 新增 curated skill：`pdf-to-markdown`

不要放在：

```text
skills/system/
```

因为系统 skill 会在 `src/index.ts` 的 `syncSystemSkills()` 中同步到所有群，这与“按群启用”冲突。

应新增：

```text
skills/curated/pdf-to-markdown/SKILL.md
```

这样可以复用现有按群安装机制：

- `list_curated_skills`
- `install_curated_skill`

安装后，skill 会出现在：

```text
groups/<group-folder>/.claude/skills/pdf-to-markdown/SKILL.md
```

### 2. Skill 内容要求

`pdf-to-markdown` skill 应至少包含以下指引：

1. 当用户要求读取、提取、整理、转换 PDF 内容时，优先调用 `mcp__markitdown__convert_to_markdown`
2. 对本地文件使用 `file://` URI
3. 将输出结果保存到：

```text
./.generated/documents/<basename>.md
```

4. 若用户要求“发给我”或“把文件回传”，使用：

```md
[xxx.md](./.generated/documents/xxx.md)
```

配合现有 `send_message` 发送

skill 中还应明确：

1. 若当前群未安装该能力，则不会看到 `markitdown` 工具
2. 当工具调用失败时，应向用户说明可能原因，而不是伪造结果

### 3. 增加外部 MCP server 配置抽象

当前 `ClaudeProvider` 的 `mcpServers` 只有进程内创建的：

```ts
mcpServers: { "octo-tools": mcpServer }
```

需要扩展 `SessionConfig`，例如：

```ts
export interface ExternalMcpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SessionConfig {
  groupFolder: string;
  workingDirectory: string;
  initialPrompt: string;
  isMain: boolean;
  resumeSessionId?: string;
  tools: ToolDefinition[];
  profile: ResolvedAgentProfile;
  externalMcpServers?: Record<string, ExternalMcpServerSpec>;
}
```

### 4. 新增外部 MCP 配置文件

建议新增：

- `config/external-mcp.example.json`

示例：

```json
{
  "servers": {
    "markitdown": {
      "enabled": true,
      "command": "markitdown-mcp",
      "args": []
    }
  }
}
```

并新增读取模块：

- `src/runtime/external-mcp-config.ts`

职责：

1. 读取配置文件
2. 校验结构
3. 返回外部 MCP server 配置

第一期只需要支持 `markitdown`，但结构要允许未来继续增加其它 server。

### 5. `markitdown-mcp` 的推荐启动方式

默认推荐支持以下配置方式：

#### 方式 A：系统已安装可执行文件

```json
{
  "servers": {
    "markitdown": {
      "enabled": true,
      "command": "markitdown-mcp",
      "args": []
    }
  }
}
```

#### 方式 B：通过 `uvx`

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

第一期不在代码里自动安装 `markitdown-mcp`，只负责读取配置并接入。

### 6. 在 `GroupQueue` 中按群判断是否启用 MarkItDown MCP

这是本次方案最关键的部分。

建议在 `src/group-queue.ts` 的 session 装配流程中：

1. 读取当前群工作目录下是否存在：

```text
groups/<group-folder>/.claude/skills/pdf-to-markdown/SKILL.md
```

2. 若存在，则说明该群已安装此 skill
3. 只有此时才从外部 MCP 配置中取出 `markitdown` server，并注入 session

伪代码示意：

```ts
const hasPdfToMarkdownSkill = existsSync(
  resolve("groups", groupFolder, ".claude", "skills", "pdf-to-markdown", "SKILL.md"),
);

const externalMcpServers = hasPdfToMarkdownSkill
  ? buildEnabledExternalMcpServers(["markitdown"])
  : {};
```

这样就满足：

- 装了 skill 的群：有能力
- 没装 skill 的群：没有能力

### 7. 在 `ClaudeProvider` 中合并外部 MCP server

当前代码大致为：

```ts
const mcpServer = buildMcpServer(config.tools);
...
mcpServers: { "octo-tools": mcpServer },
allowedTools: [
  "Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill",
  ...toolNames,
]
```

需要扩展为：

1. `mcpServers` 合并：
   - 内置 `octo-tools`
   - 条件注入的外部 `markitdown`

例如：

```ts
mcpServers: {
  "octo-tools": mcpServer,
  ...(config.externalMcpServers ?? {}),
}
```

2. `allowedTools` 也要同步放行：

```ts
"mcp__markitdown__*"
```

但仅在当前 session 注入了 `markitdown` 时才加入。

建议新增 helper：

```ts
function buildExternalMcpAllowedTools(
  externalMcpServers: Record<string, ExternalMcpServerSpec>,
): string[]
```

若当前存在 `markitdown`，返回：

```ts
["mcp__markitdown__*"]
```

### 8. 输出文件统一放到 `.generated/documents/`

转换结果不建议散落在 group 根目录，建议统一放到：

```text
groups/<groupFolder>/.generated/documents/
```

例如：

```text
groups/main/.generated/documents/AI素养评价_产品手册.md
```

这样与当前 `.generated/images/` 风格一致，也方便查找和清理。

agent 在 skill 指引下的标准工作流应是：

1. 读取收到的 PDF 路径
2. 构造 `file://` URI
3. 调 `mcp__markitdown__convert_to_markdown`
4. 用 `Write` 把结果保存到 `.generated/documents/xxx.md`
5. 用 `send_message` 发送：

```md
[AI素养评价_产品手册.md](./.generated/documents/AI素养评价_产品手册.md)
```

### 9. 与现有“文件路径可读提示”能力协同

当前 provider 已经会为接收到的本地文件链接补充 agent 可读路径，例如：

```text
[AI素养评价_产品手册.pdf](media/oc_xxx/om_xxx-AI素养评价_产品手册.pdf)
可读路径: ../../media/oc_xxx/om_xxx-AI素养评价_产品手册.pdf
```

这意味着 skill 里可以直接指导 agent：

1. 优先使用“可读路径”构造 `file://` URI
2. 若没有可读路径，再根据 Markdown link 自行解析

因此这次不需要改动现有文件接收链路，只需要在 skill 指南中明确利用它。

### 10. 使用方式

目标群启用流程：

1. 在目标群里调用：

```text
install_curated_skill
skillName = "pdf-to-markdown"
```

2. 后续该群启动新 session 时，就会自动注入 `markitdown` MCP
3. 用户发送 PDF，并提出类似请求：
   - “帮我转成 Markdown 发回来”
   - “提取这个 PDF 的正文并回传 md”

4. agent 调用 `markitdown`
5. agent 发送 `.md` 文件回飞书

未安装该 skill 的群：

1. 看不到对应 skill
2. session 不注入 `markitdown`
3. `mcp__markitdown__*` 不在该群的 allowed tools 里

### 11. README 与运维说明

README 需要新增两类说明：

#### 11.1 如何安装外部程序

例如：

```bash
pip install markitdown-mcp
```

或：

```bash
uv tool install markitdown-mcp
```

#### 11.2 如何按群启用

说明：

1. 先配置 `config/external-mcp.json`
2. 再在目标群安装 curated skill：

```text
install_curated_skill("pdf-to-markdown")
```

只有装了这个 skill 的群才有该能力。

### 12. 测试方案

#### 12.1 `tests/providers.test.ts`

至少新增覆盖：

1. 未注入外部 MCP 时，`allowedTools` 不包含 `mcp__markitdown__*`
2. 注入 `markitdown` 时，`mcpServers` 会同时包含：
   - `octo-tools`
   - `markitdown`
3. 注入 `markitdown` 时，`allowedTools` 会包含：

```text
mcp__markitdown__*
```

#### 12.2 外部 MCP 配置读取测试

如果新增 `src/runtime/external-mcp-config.ts`，应补测试覆盖：

1. 默认配置读取
2. `enabled = false` 时不返回
3. 配置缺失 `command` 时抛出明确错误
4. 支持 `args`

#### 12.3 群级 gating 测试

建议新增或补充：

1. 当 `groups/<group>/.claude/skills/pdf-to-markdown/SKILL.md` 存在时，session config 会带上 `markitdown`
2. 当 skill 不存在时，不会带上 `markitdown`

#### 12.4 curated skill 工具测试

当前已有：

- `list_curated_skills`
- `install_curated_skill`

只需确保新增 skill 后，这两个工具无需改逻辑即可正常工作；必要时补一个测试，验证 `pdf-to-markdown` 能被列出和安装。

## 需要修改的文件建议

建议新增 / 修改如下：

- `skills/curated/pdf-to-markdown/SKILL.md`
- `src/providers/types.ts`
- `src/runtime/external-mcp-config.ts`
- `src/group-queue.ts`
- `src/providers/claude.ts`
- `config/external-mcp.example.json`
- `README.md`
- `tests/providers.test.ts`
- `tests/external-mcp-config.test.ts`
- 可能补充 `tests/tools.test.ts` 或现有工具测试

## Todo List

- [x] 新增 curated skill：`skills/curated/pdf-to-markdown/SKILL.md`
- [x] 设计 `SessionConfig` 的外部 MCP 配置结构
- [x] 新增外部 MCP 配置读取模块
- [x] 新增 `config/external-mcp.example.json`
- [x] 在 `GroupQueue` 中按群检查是否安装 `pdf-to-markdown` skill
- [x] 仅对安装该 skill 的群注入 `markitdown` MCP server
- [x] 在 `ClaudeProvider` 中合并内置 `octo-tools` 与外部 `markitdown` MCP server
- [x] 在 `ClaudeProvider` 中仅对启用该能力的群放行 `mcp__markitdown__*`
- [x] 在 skill 中约定转换结果输出到 `.generated/documents/`
- [x] 在 README 中补充 `markitdown-mcp` 安装、配置、按群启用说明
- [x] 增加 `providers` 侧测试
- [x] 增加外部 MCP 配置读取测试
- [x] 增加群级 skill gating 测试
- [x] 用户评审 spec 后再进入实现
