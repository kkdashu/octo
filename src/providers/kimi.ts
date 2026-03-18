import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../logger";
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionConfig,
} from "./types";

const TAG = "kimi-provider";

/**
 * Bun's spawn has a pipe buffering incompatibility with kimi CLI (Rust binary)
 * where stdout data is never delivered. We work around this by spawning a Node.js
 * process that runs the kimi SDK and relays events as JSONL over stdout.
 */
export class KimiProvider implements AgentProvider {
  readonly name = "kimi";

  async startSession(config: SessionConfig): Promise<{
    session: AgentSession;
    events: AsyncIterable<AgentEvent>;
  }> {
    log.info(TAG, `=== Starting session for group: ${config.groupFolder} ===`, {
      groupFolder: config.groupFolder,
      isMain: config.isMain,
      hasResume: !!config.resumeSessionId,
      promptLength: config.initialPrompt.length,
    });

    const toolDefs = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }));

    const child = spawn("node", ["-e", NODE_WRAPPER_SCRIPT], {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        KIMI_SESSION_CONFIG: JSON.stringify({
          workDir: config.workingDirectory,
          sessionId: config.resumeSessionId,
          model: process.env.KIMI_MODEL,
          yoloMode: true,
          toolDefs,
        }),
        KIMI_INITIAL_PROMPT: config.initialPrompt,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr?.on("data", (d) => {
      log.debug(TAG, `[stderr] ${d.toString().trim()}`);
    });

    const rl = createInterface({ input: child.stdout! });
    let closed = false;

    function push(text: string) {
      if (closed) return;
      child.stdin?.write(JSON.stringify({ type: "prompt", text }) + "\n");
    }

    function close() {
      closed = true;
      child.stdin?.write(JSON.stringify({ type: "close" }) + "\n");
      child.stdin?.end();
    }

    async function* eventStream(): AsyncGenerator<AgentEvent> {
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "text" && msg.text) {
              yield { type: "text", text: msg.text };
            } else if (msg.type === "result") {
              yield { type: "result", sessionId: msg.sessionId };
            } else if (msg.type === "error") {
              yield { type: "error", error: new Error(msg.error) };
            }
          } catch {
            // skip unparseable lines
          }
        }
      } catch (err) {
        log.error(TAG, `Event stream error`, err);
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      }
    }

    return { session: { push, close }, events: eventStream() };
  }
}

/**
 * Node.js wrapper script that runs kimi SDK and outputs events as JSONL.
 * Executed via `node -e` to bypass Bun's pipe incompatibility with kimi CLI.
 */
const NODE_WRAPPER_SCRIPT = `
const { createSession } = require("@moonshot-ai/kimi-agent-sdk");
const readline = require("readline");

const config = JSON.parse(process.env.KIMI_SESSION_CONFIG);
const initialPrompt = process.env.KIMI_INITIAL_PROMPT;

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

// Build ExternalTool objects directly (skip createExternalTool which requires Zod)
const externalTools = (config.toolDefs || []).map(t => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  handler: async (params) => {
    return { output: JSON.stringify(params), message: "executed" };
  },
}));

const session = createSession({
  workDir: config.workDir,
  ...(config.sessionId ? { sessionId: config.sessionId } : {}),
  ...(config.model ? { model: config.model } : {}),
  yoloMode: config.yoloMode ?? true,
  externalTools,
});

async function runTurn(prompt) {
  const turn = session.prompt(prompt);
  let buffer = "";
  for await (const event of turn) {
    if (event.type === "ContentPart" && event.payload?.type === "text" && event.payload.text) {
      buffer += event.payload.text;
    }
  }
  if (buffer) emit({ type: "text", text: buffer });
  emit({ type: "turn_done", sessionId: session.sessionId });
}

runTurn(initialPrompt).then(() => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "prompt") await runTurn(msg.text);
      else if (msg.type === "close") {
        await session.close();
        emit({ type: "result", sessionId: session.sessionId });
        process.exit(0);
      }
    } catch (err) {
      emit({ type: "error", error: err.message || String(err) });
    }
  });
}).catch((err) => {
  emit({ type: "error", error: err.message || String(err) });
  process.exit(1);
});
`.trim();
