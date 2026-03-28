# MiniMax 图片平台前处理方案

## 问题描述

当前 Octo 已经支持从飞书接收图片消息，并把图片落盘到：

```text
media/<chatId>/<messageId>.<ext>
```

消息正文中保存为 Markdown 图片：

```md
![image](media/oc_xxx/om_xxx.jpg)
```

但现有图片处理链路存在结构性问题：

1. 主模型收到的并不是真正稳定的图片理解结果，而是“图片路径 + 让 agent 自己去读图”的提示文本。
2. 对于 `minimax` profile，Anthropic 兼容接口明确不支持 `messages[].content` 中的 `type="image"`，也会忽略 `mcp_servers` 参数，因此不能依赖“主模型自己看图”。
3. 即使通过 `Read` 工具读取本地图片，当前主模型链路仍可能把提示词本身当成图片内容，导致明显误识别。
4. 目前没有图片理解缓存，同一张图片在多轮对话、session 恢复、历史重放时可能被重复识别，增加时延和成本。

本需求的目标已经由用户明确确认：

1. 采用“平台前处理”方案，不让主模型自行决定是否调用图片理解 MCP。
2. 所有 profile 一视同仁，图片统一优先走 MiniMax `understand_image`。
3. `MINIMAX_API_KEY` 就是 Token Plan key，直接用于调用官方 MCP。
4. 必须做缓存，避免重复识别同一张图片。
5. `understand_image` 的提示词必须收敛，只输出客观描述、OCR 文本、与图片本身直接相关的关键信息，不允许自由发挥。

本次需求的非目标：

1. 不改飞书收图与图片落盘路径规则。
2. 不改数据库里原始消息内容的存储格式，仍保留 Markdown 图片。
3. 不让主模型直接接触图片文件、图片路径提示词或 `understand_image` 工具名。
4. 不为不同 profile 设计不同图片链路。

## 对现有项目的影响

### 需要修改的文件

- `package.json`
  新增 MCP client 依赖。
- `src/index.ts`
  初始化图片前处理服务，并注入 `ClaudeProvider`。
- `src/providers/claude.ts`
  把当前“图片路径提示文本”改为“平台前处理后得到的文本理解结果”。
- `src/db.ts`
  新增图片理解缓存表及读写 helper。
- `env.example`
  补充 MiniMax MCP 相关运行时环境变量说明。
- `docs/octo.md`
  补充图片前处理链路说明。
- `tests/providers.test.ts`
  更新 provider 图片消息测试。
- `tests/runtime.test.ts`
  增加运行时配置与 MiniMax MCP 初始化相关测试。

### 需要新增的文件

- `src/runtime/minimax-token-plan-mcp.ts`
  MiniMax Token Plan MCP 的平台侧 client，负责通过 stdio 调用 `understand_image`。
- `src/runtime/image-message-preprocessor.ts`
  图片消息前处理服务：解析 Markdown 图片、命中缓存、调用 MCP、格式化文本结果。
- `tests/image-message-preprocessor.test.ts`
  图片前处理与缓存相关测试。

### 数据与运行时影响

#### 1. 新增图片理解缓存表

计划在 SQLite 中新增表：

```sql
CREATE TABLE IF NOT EXISTS image_understanding_cache (
  cache_key TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  analysis_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

设计要点：

1. `cache_key` 由 `file_sha256 + prompt_version` 组成。
2. 不直接只用 `image_path` 做 key，避免同一路径文件被覆盖后读到旧缓存。
3. `prompt_version` 用于未来调整分析提示词时主动失效旧缓存。

#### 2. 新增一个平台侧 MiniMax MCP client

运行时会启动一个平台内部使用的 MCP stdio client，调用官方：

```bash
uvx minimax-coding-plan-mcp -y
```

并注入：

```text
MINIMAX_API_KEY
MINIMAX_API_HOST=https://api.minimaxi.com
```

注意：

1. 这个 MCP client 只供 Node 平台代码使用。
2. 它不会暴露给主模型，不会加入主 `query()` 的 `mcpServers`。
3. 主模型对图片的感知只来自前处理后的纯文本。

#### 3. 主模型输入将彻底变成纯文本

当前链路中，`ClaudeProvider` 会把图片替换成类似：

```text
[图片路径: /abs/path/to/file.jpg。请使用 Read 工具读取该图片后再分析...]
```

本次改造后，主模型只会收到统一格式的文本块，例如：

```text
[图片理解结果]
路径: media/oc_xxx/om_xxx.jpg
客观描述: 一只戴着彩色伊丽莎白圈的白猫，猫脸朝上，画面主体居中。
OCR文本: 无
关键信息: 画面中未见聊天界面、票据、表格或明显可读文档。
[/图片理解结果]
```

也就是说：

1. 主模型不再看到 `Read` 指令。
2. 主模型不再直接处理图片路径提示词。
3. 无论底层 profile 是 `claude`、`codex`、`kimi` 还是 `minimax`，主模型输入都保持一致。

### 风险与约束

#### 1. `uvx` 或 MCP server 不可用时必须降级

根据 MiniMax 文档，若本机未安装 `uvx`，会出现 `spawn uvx ENOENT`。因此实现必须采用“失败可降级”的策略：

1. 平台记录错误日志。
2. 对当前图片输出可诊断的失败占位文本。
3. 不阻断整条消息发送给主模型。

建议占位文本：

```text
[图片理解失败: media/oc_xxx/om_xxx.jpg]
```

#### 2. 不允许平台前处理自由发挥

图片理解提示词必须尽量结构化、约束化，避免把“猫图”理解成“聊天截图”这类幻觉描述。

#### 3. 缓存必须与提示词版本绑定

因为用户已经明确要求分析提示词需要收敛，所以后续一旦调整提示词，不应继续复用旧缓存结果。

#### 4. 不应把原始图片消息内容改写进数据库

原始消息仍应保留 Markdown 图片格式，方便排障与重放。前处理只发生在“送入模型之前”的运行时阶段。

## 实现方案

### 一、总体架构

目标链路：

```text
飞书消息入库
  -> 数据库里仍保存原始 Markdown 图片
  -> Router / GroupQueue 组装 prompt
  -> ClaudeProvider.startSession()
    -> ImageMessagePreprocessor.preprocess(text)
      -> 解析 Markdown 图片
      -> 查询 image_understanding_cache
      -> miss 时调用 MiniMax understand_image
      -> 写入缓存
      -> 把图片替换为统一文本理解结果
    -> query() 只收到纯文本 prompt
    -> 主模型继续按原逻辑处理
```

这里的关键架构决策是：

1. 图片理解发生在平台层，而不是 agent 决策层。
2. 图片理解结果在进入主模型前已经文本化。
3. 主模型与图片工具彻底解耦。

### 二、平台侧 MiniMax MCP client

新增文件：

- `src/runtime/minimax-token-plan-mcp.ts`

建议抽象：

```ts
export interface ImageUnderstandingClient {
  understandImage(input: {
    imagePath: string;
    prompt: string;
  }): Promise<string>;
}

export class MiniMaxTokenPlanMcpClient implements ImageUnderstandingClient {
  // 内部维护 stdio transport + MCP client
}
```

实现策略：

1. 使用 `@modelcontextprotocol/sdk` 建立 stdio client。
2. 通过 `uvx minimax-coding-plan-mcp -y` 启动官方 MCP server。
3. 初始化后调用 `understand_image` 工具：

```json
{
  "prompt": "<收敛后的分析提示词>",
  "image_url": "/absolute/path/to/media/oc_xxx/om_xxx.jpg"
}
```

4. 使用单例或懒加载复用同一个 MCP client，避免每张图都重新拉起进程。
5. 若初始化失败或工具调用失败，抛出平台内部错误，由上层做降级。

### 三、图片前处理服务

新增文件：

- `src/runtime/image-message-preprocessor.ts`

建议抽象：

```ts
export interface ImageMessagePreprocessorDeps {
  analyzeImage: ImageUnderstandingClient;
  db: Database;
  now?: () => string;
}

export async function preprocessMessageImages(
  db: Database,
  text: string,
  rootDir: string,
  deps: ImageMessagePreprocessorDeps,
): Promise<string>
```

处理步骤：

1. 对输入文本先执行 `normalizeLegacyImageSyntax()`。
2. 用 `parseMessageParts()` 解析文本和图片片段。
3. 文本片段原样保留。
4. 图片片段执行：
   1. 校验路径必须位于 `media/` 下。
   2. 解析绝对路径，确认文件存在。
   3. 读取文件并计算 `sha256`。
   4. 用 `sha256 + promptVersion` 查询缓存。
   5. 命中则直接返回缓存文本。
   6. 未命中则调用 `understand_image`。
   7. 格式化结果并写入缓存。
5. 将整条消息重新拼回纯文本。

### 四、缓存策略

缓存方案采用“DB 持久化缓存 + 提示词版本失效”：

#### 缓存命中条件

```text
cache_key = sha256(file bytes) + prompt_version
```

这样能同时满足：

1. 同一张图片跨多轮、多次恢复 session 时不重复识别。
2. 同一路径文件被覆盖时缓存自动失效。
3. 调整图片理解 prompt 后可通过版本号整体失效旧结果。

#### 建议 helper

在 `src/db.ts` 新增：

```ts
export interface ImageUnderstandingCacheRow {
  cache_key: string;
  image_path: string;
  file_sha256: string;
  prompt_version: string;
  analysis_text: string;
  created_at: string;
  updated_at: string;
}

export function getImageUnderstandingCache(
  db: Database,
  cacheKey: string,
): ImageUnderstandingCacheRow | null

export function upsertImageUnderstandingCache(
  db: Database,
  row: ImageUnderstandingCacheRow,
): void
```

### 五、收敛版 `understand_image` 提示词

为了防止图片理解结果自由发挥，平台侧固定使用一个版本化 prompt，例如：

```text
你是图片理解预处理器。你的任务是只基于图片本身输出客观信息，禁止猜测对话意图、拍摄背景、用户目的或图片外信息。

请严格按以下格式输出：
客观描述: <一句到两句，描述画面主体、布局、可见对象，不做推断>
OCR文本: <逐行列出图片中清晰可读的文字；如果没有则写“无”>
关键信息: <只列出与图片本身直接相关的可观察事实，例如时间、状态、按钮、票据字段、界面元素、异常提示；如果没有则写“无”>

规则：
1. 看不清的内容写“无法辨认”，不要猜。
2. 不要总结用户意图，不要解释图片“想表达什么”。
3. 不要使用“看起来像是在提醒”“似乎表示”这类推断句式。
4. 输出必须简洁、客观、稳定。
```

实现时定义常量：

```ts
const IMAGE_UNDERSTANDING_PROMPT_VERSION = "v1";
const IMAGE_UNDERSTANDING_PROMPT = `...`;
```

### 六、主模型侧的输入格式

图片前处理后的结果必须统一包装，便于主模型消费，也便于日志排障。

建议格式：

```text
[图片理解结果]
路径: media/oc_xxx/om_xxx.jpg
客观描述: ...
OCR文本: ...
关键信息: ...
[/图片理解结果]
```

如果图片理解失败：

```text
[图片理解失败: media/oc_xxx/om_xxx.jpg]
```

如果图片文件本身缺失：

```text
[图片读取失败: media/oc_xxx/om_xxx.jpg]
```

### 七、接入点选择

当前所有群最终都走 `ClaudeProvider.startSession()`，因此平台前处理的最佳接入点就是 provider 侧，而不是 router 或 channel 侧。

具体改法：

1. `src/index.ts` 中初始化 `MiniMaxTokenPlanMcpClient` 与图片前处理服务。
2. 把该依赖注入 `ClaudeProvider`。
3. `ClaudeProvider` 中把当前同步的 `buildClaudeMessageContent()` 改造成异步前处理流程。
4. `messageGenerator()` 在每次 `yield` 前先 `await preprocessMessageImages(...)`。

伪代码：

```ts
async function makeUserMessage(
  content: string,
  rootDir: string,
): Promise<SDKUserMessage> {
  const processed = await preprocessMessageImages(db, content, rootDir, deps);
  return {
    type: "user",
    message: { role: "user", content: processed },
    parent_tool_use_id: null,
    session_id: "",
  };
}
```

### 八、测试方案

需要覆盖以下场景：

#### 1. 前处理基础行为

- Markdown 图片被替换为图片理解文本块
- 旧 `[IMAGE:...]` 语法会先归一化再前处理
- 非 `media/` 路径不会调用图片理解
- 文件缺失时输出 `[图片读取失败: ...]`

#### 2. 缓存行为

- 首次识图走 MCP，随后写入缓存
- 同一文件 + 同一 promptVersion 再次处理时命中缓存，不再调用 MCP
- 相同路径但文件 hash 变化时不会复用旧缓存
- promptVersion 变化时不会复用旧缓存

#### 3. provider 接入行为

- `ClaudeProvider` 最终传给 `query()` 的内容是纯文本，不再包含 `Read` 指令或图片路径提示词
- 不同 profile 下，图片前处理输出格式一致

#### 4. 运行时降级行为

- MCP 初始化失败时，provider 不崩溃，图片变成失败占位文本
- `MINIMAX_API_KEY` 缺失时给出明确错误日志并降级

## Todo List

- [x] 新建 `specs/minimax-image-platform-preprocess.md` 并完成评审
- [x] 在 `package.json` 中增加平台侧 MCP client 所需依赖
- [x] 在 `src/db.ts` 中新增 `image_understanding_cache` 表与读写 helper
- [x] 新增 `src/runtime/minimax-token-plan-mcp.ts`，封装官方 `understand_image` 工具调用
- [x] 新增 `src/runtime/image-message-preprocessor.ts`，实现图片消息解析、缓存命中与文本替换
- [x] 在 `src/index.ts` 中初始化图片前处理服务并注入 `ClaudeProvider`
- [x] 在 `src/providers/claude.ts` 中把图片路径提示链路替换为异步平台前处理链路
- [x] 在 `env.example` 中补充 MiniMax MCP 相关环境变量说明
- [x] 在 `docs/octo.md` 中补充“图片统一走 MiniMax understand_image 前处理”的运行机制说明
- [x] 更新 `tests/providers.test.ts`，覆盖 provider 纯文本输入行为
- [x] 新增 `tests/image-message-preprocessor.test.ts`，覆盖缓存命中、失效、降级和格式化逻辑
- [x] 更新 `tests/runtime.test.ts`，覆盖 MiniMax MCP 初始化配置与依赖注入行为
- [x] 运行相关测试并确认通过
