import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClaudeSdkModule = any;

let claudeSdkPromise: Promise<ClaudeSdkModule> | null = null;

const CLAUDE_SDK_PATH_PARTS = ['@anthropic-ai', 'claude-agent-sdk'];

/**
 * Resolve the Claude Agent SDK path.
 * Searches:
 * 1. node_modules relative to the calling package (require.resolve)
 * 2. process.cwd()/node_modules
 * 3. __dirname-relative node_modules (for installed package scenario)
 */
function getClaudeSdkPath(): string {
  // Try require.resolve first (works in most Node.js scenarios)
  try {
    const sdkPackageJsonPath = require.resolve(
      `${CLAUDE_SDK_PATH_PARTS.join('/')}/package.json`
    );
    const sdkDir = join(sdkPackageJsonPath, '..');
    const sdkPath = join(sdkDir, 'sdk.mjs');
    if (existsSync(sdkPath)) {
      return sdkPath;
    }
  } catch {
    // require.resolve failed, fall through to manual search
  }

  // Fallback: search relative to cwd
  const cwdPath = join(process.cwd(), 'node_modules', ...CLAUDE_SDK_PATH_PARTS, 'sdk.mjs');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  // Fallback: search relative to this file's location
  const selfPath = join(__dirname, '..', 'node_modules', ...CLAUDE_SDK_PATH_PARTS, 'sdk.mjs');
  if (existsSync(selfPath)) {
    return selfPath;
  }

  // Return the cwd path as best guess even if not found yet
  return cwdPath;
}

export function getClaudeCodeCliPath(): string {
  try {
    const cliPath = require.resolve(`${CLAUDE_SDK_PATH_PARTS.join('/')}/cli.js`);
    if (existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // fall through
  }

  const cwdPath = join(process.cwd(), 'node_modules', ...CLAUDE_SDK_PATH_PARTS, 'cli.js');
  if (existsSync(cwdPath)) return cwdPath;

  const selfPath = join(__dirname, '..', 'node_modules', ...CLAUDE_SDK_PATH_PARTS, 'cli.js');
  if (existsSync(selfPath)) return selfPath;

  return cwdPath;
}

export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (!claudeSdkPromise) {
    // Use runtime dynamic import so CJS build can load the SDK's ESM entry.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ClaudeSdkModule>;

    const sdkPath = getClaudeSdkPath();
    const sdkUrl = pathToFileURL(sdkPath).href;
    const sdkExists = existsSync(sdkPath);

    console.log('[mini_cowork] Loading Claude SDK:', { sdkPath, sdkExists });

    claudeSdkPromise = dynamicImport(sdkUrl).catch((error) => {
      console.error('[mini_cowork] Failed to load Claude SDK:', {
        error: error instanceof Error ? error.message : String(error),
        sdkPath,
        sdkExists,
      });
      claudeSdkPromise = null;
      throw error;
    });
  }

  return claudeSdkPromise;
}
