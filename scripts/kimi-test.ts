/**
 * Test kimi provider via Node wrapper (bypasses Bun spawn pipe issue)
 * Run: bun scripts/kimi-test.ts
 */
import { KimiProvider } from "../src/providers/kimi";

const provider = new KimiProvider();
const { session, events } = await provider.startSession({
  groupFolder: "test",
  workingDirectory: process.cwd(),
  initialPrompt: "你好，你是谁？用一句话回答",
  isMain: false,
  tools: [],
});

for await (const event of events) {
  if (event.type === "text") {
    process.stdout.write(event.text);
  } else if (event.type === "result") {
    console.log("\n[result] sessionId:", event.sessionId);
    break;
  } else if (event.type === "error") {
    console.error("\n[error]", event.error.message);
    break;
  }
}

session.close();
