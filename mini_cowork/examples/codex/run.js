/**
 * Kimi Coding Plan 示例
 *
 * 使用前：
 *   1. 将 config.json 中的 apiKey 替换为你的 Kimi API Key
 *   2. node run.js
 */

const path = require('path');
const { MiniCowork } = require('../../dist/index.js');

async function main() {
  const runner = new MiniCowork({
    configPath: path.join(__dirname, 'config.json'),
    workingDirectory: process.cwd(),
  });

  await runner.start();

  // 解析参数：node run.js [--session <id>] [prompt...]
  const args = process.argv.slice(2);
  let sessionId;
  let promptParts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session' && args[i + 1]) {
      sessionId = args[++i];
    } else {
      promptParts.push(args[i]);
    }
  }
  const prompt = promptParts.join(' ') || '用 Python 写一个快速排序，并附上单元测试';

  console.log(`\n提问：${prompt}\n`);
  console.log('─'.repeat(50));

  for await (const event of runner.run({ prompt, sessionId, autoApprove: true })) {
    switch (event.type) {
      case 'text':
        process.stdout.write(event.content);
        break;
      case 'thinking':
        process.stderr.write(`\x1b[2m[思考中...]\x1b[0m\n`);
        break;
      case 'tool_use':
        process.stderr.write(`\x1b[33m[工具] ${event.name}\x1b[0m\n`);
        break;
      case 'complete':
        sessionId = event.claudeSessionId;
        break;
      case 'error':
        console.error(`\n错误: ${event.message}`);
        process.exit(1);
    }
  }

  console.log('\n' + '─'.repeat(50));
  if (sessionId) {
    console.log(`\nSession ID: ${sessionId}`);
    console.log(`继续对话: node run.js --session ${sessionId} "你的下一个问题"`);
  }

  await runner.stop();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
