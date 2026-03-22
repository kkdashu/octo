# mini_cowork

独立的多 Provider Claude Agent SDK 运行器，支持 DeepSeek、Kimi、Qwen、Gemini 等主流 AI 服务，无需 Electron 依赖。

从 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 提取的核心 Provider 支持逻辑，以 Node.js 库 + CLI 形式发布。

## 特性

- **多 Provider 支持** — Anthropic、DeepSeek、Kimi/Moonshot、Qwen、Gemini、GLM、Volcengine、MiniMax、Ollama、OpenRouter 等
- **OpenAI 兼容代理** — 内置 HTTP 代理服务器，自动将 Anthropic 格式转换为 OpenAI 格式（支持流式）
- **Coding Plan 支持** — DeepSeek、Kimi、Qwen、Volcengine 的专属 Coding 端点
- **CLI 工具** — 交互式对话 + 单次执行模式
- **库 API** — 可在其他项目中直接 import 使用
- **异步生成器接口** — 逐事件迭代，支持流式文本输出

## 安装

```bash
# 从源码构建
git clone <repo>
cd mini_cowork
npm install
npm run build

# 全局安装 CLI（可选）
npm install -g .
```

## 快速开始

### 1. 创建配置文件

```bash
# 在当前目录创建 mini_cowork.config.json
node dist/cli.js config init

# 或创建全局配置 ~/.mini_cowork/config.json
node dist/cli.js config init --global
```

### 2. 填写 API Key

编辑生成的配置文件，将 `YOUR_DEEPSEEK_API_KEY` 替换为真实的 API Key：

```json
{
  "model": {
    "defaultModel": "deepseek-chat"
  },
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKey": "sk-xxxxxxxxxxxxxxxx",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiFormat": "anthropic",
      "models": [
        { "id": "deepseek-chat" },
        { "id": "deepseek-reasoner" }
      ]
    }
  }
}
```

### 3. 运行

```bash
# 单次执行
node dist/cli.js run "帮我写一个 hello world Python 脚本"

# 交互模式
node dist/cli.js
```

## CLI 用法

```
mini-cowork [选项] [命令]

命令:
  run [prompt...]      单次执行模式
  interactive / i      交互式对话模式（默认）
  config show          查看当前配置
  config init          生成默认配置文件
  config list-providers  列出所有支持的 Provider

全局选项:
  -c, --config <path>  指定配置文件路径
  -d, --dir <path>     工具执行的工作目录
  --system <prompt>    注入系统提示词
  --silent             静默模式（不打印日志）
  -h, --help           显示帮助
```

### 示例

```bash
# 单次执行，使用指定工作目录
node dist/cli.js run -d /path/to/project "重构 src/index.ts，添加错误处理"

# 单次执行，自动批准工具权限
node dist/cli.js run --auto-approve "列出当前目录的文件"

# 继续上次会话
node dist/cli.js run --session <session-id> "继续上面的任务"

# 使用自定义配置文件
node dist/cli.js -c ~/my-config.json run "..."
```

## 库 API

### 基本用法

```typescript
import { MiniCowork } from 'mini_cowork';

const runner = new MiniCowork({
  configPath: './mini_cowork.config.json', // 可选，默认自动发现
  workingDirectory: '/path/to/project',    // 可选
  systemPrompt: '你是一名资深工程师',        // 可选
});

await runner.start();

for await (const event of runner.run('帮我写一个 hello world')) {
  if (event.type === 'text') {
    process.stdout.write(event.content);
  } else if (event.type === 'tool_use') {
    console.log(`[工具调用] ${event.name}`);
  } else if (event.type === 'error') {
    console.error('错误:', event.message);
  }
}

await runner.stop();
```

### 事件类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `text` | `content: string` | 助手输出的文本内容（流式） |
| `thinking` | `content: string` | 思考过程（部分模型支持） |
| `tool_use` | `name`, `input`, `toolUseId` | 工具调用请求 |
| `tool_result` | `toolUseId`, `content` | 工具执行结果 |
| `complete` | `claudeSessionId?` | 会话完成，返回 session ID |
| `error` | `message: string` | 执行出错 |

### 多轮对话

```typescript
const runner = new MiniCowork({ configPath: './mini_cowork.config.json' });
await runner.start();

let sessionId: string | undefined;

// 第一轮
for await (const event of runner.run({ prompt: '我叫小明' })) {
  if (event.type === 'text') process.stdout.write(event.content);
  if (event.type === 'complete') sessionId = event.claudeSessionId ?? undefined;
}

// 继续对话
for await (const event of runner.run({ prompt: '我刚才说我叫什么？', sessionId })) {
  if (event.type === 'text') process.stdout.write(event.content);
}

await runner.stop();
```

### 便捷函数

```typescript
import { runOnce } from 'mini_cowork';

// 一次性执行，自动管理生命周期
const events = await runOnce('写一个冒泡排序', {
  configPath: './mini_cowork.config.json',
  workingDirectory: '/tmp/test',
});

const text = events
  .filter(e => e.type === 'text')
  .map(e => e.content)
  .join('');
console.log(text);
```

### 只获取文本输出

```typescript
const result = await runner.runText('用一句话介绍 TypeScript');
console.log(result);
```

## 配置文件说明

配置文件按以下优先级自动发现：
1. `--config` 参数指定的路径
2. 当前目录下的 `mini_cowork.config.json`
3. `~/.mini_cowork/config.json`

### 完整配置示例

```json
{
  "model": {
    "defaultModel": "kimi-k2.5"
  },
  "providers": {
    "moonshot": {
      "enabled": true,
      "apiKey": "sk-xxxxxxxx",
      "baseUrl": "https://api.moonshot.cn/anthropic",
      "apiFormat": "anthropic",
      "codingPlanEnabled": false,
      "models": [
        { "id": "kimi-k2.5" }
      ]
    },
    "deepseek": {
      "enabled": true,
      "apiKey": "sk-xxxxxxxx",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiFormat": "anthropic",
      "models": [
        { "id": "deepseek-chat" },
        { "id": "deepseek-reasoner" }
      ]
    },
    "ollama": {
      "enabled": true,
      "apiKey": "",
      "baseUrl": "http://localhost:11434/v1",
      "apiFormat": "openai",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

### Provider 列表

查看所有支持的 Provider 及默认配置：

```bash
node dist/cli.js config list-providers
```

| Provider | API 格式 | 默认 Base URL |
|----------|----------|--------------|
| `anthropic` | anthropic | `https://api.anthropic.com` |
| `deepseek` | anthropic | `https://api.deepseek.com/anthropic` |
| `moonshot` | anthropic | `https://api.moonshot.cn/anthropic` |
| `qwen` | anthropic | `https://dashscope.aliyuncs.com/apps/anthropic` |
| `zhipu` | anthropic | `https://open.bigmodel.cn/api/anthropic` |
| `volcengine` | anthropic | `https://ark.cn-beijing.volces.com/api/compatible` |
| `minimax` | anthropic | `https://api.minimaxi.com/anthropic` |
| `openrouter` | anthropic | `https://openrouter.ai/api` |
| `gemini` | openai | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `openai` | openai | `https://api.openai.com` |
| `ollama` | openai | `http://localhost:11434/v1` |
| `custom` | openai | _(自定义)_ |

### Coding Plan 模式

部分国内 Provider 提供专属的 Coding API 端点，将 `codingPlanEnabled` 设为 `true` 启用：

```json
{
  "providers": {
    "moonshot": {
      "enabled": true,
      "apiKey": "sk-xxx",
      "codingPlanEnabled": true,
      "models": [{ "id": "kimi-k2.5" }]
    }
  }
}
```

支持 Coding Plan 的 Provider：`moonshot`、`qwen`、`zhipu`、`volcengine`

## OpenAI 兼容代理

当使用 `apiFormat: "openai"` 的 Provider（如 Gemini、Ollama、自定义端点）时，mini_cowork 会自动在本地启动一个 HTTP 代理服务器，将 Claude Agent SDK 发出的 Anthropic 格式请求转换为 OpenAI 格式，再转发到上游。

代理功能：
- 请求格式转换（Anthropic → OpenAI Chat Completions / Responses API）
- 流式响应转换（OpenAI SSE → Anthropic SSE）
- 错误重试（max_tokens 范围、工具不支持等情况）
- Gemini 思维签名（thought_signature）处理
- MiniMax 多 system message 合并

## 开发

```bash
# 安装依赖
npm install

# 编译（监听模式）
npm run build:watch

# 运行测试
npm test
```

## 项目来源

本项目从 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 中提取，去除所有 Electron 依赖，保留多 Provider 支持的核心逻辑。

核心文件对应关系：

| mini_cowork | LobsterAI 源文件 |
|-------------|-----------------|
| `src/transform.ts` | `src/main/libs/coworkFormatTransform.ts` |
| `src/proxy.ts` | `src/main/libs/coworkOpenAICompatProxy.ts` |
| `src/settings.ts` | `src/main/libs/claudeSettings.ts` |
| `src/sdkLoader.ts` | `src/main/libs/claudeSdk.ts` |
| `src/runner.ts` | `src/main/libs/coworkRunner.ts`（精简版） |
| `src/config/providers.ts` | `src/renderer/config.ts` |

## License

MIT
