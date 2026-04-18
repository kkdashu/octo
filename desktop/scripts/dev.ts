import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";

const DEV_HOSTNAME = "127.0.0.1";
const DEV_PORT = 1420;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const distDir = join(projectDir, "dist");
const entrypoint = join(projectDir, "src", "index.html");

function toFilePath(pathname: string): string {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(normalizedPath.replace(/^\/+/, ""))
    .replace(/^(\.\.[/\\])+/, "");
  return join(distDir, safePath);
}

const initialBuild = Bun.spawnSync(
  ["bun", "build", entrypoint, "--outdir", distDir, "--target", "browser"],
  {
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

if (initialBuild.exitCode !== 0) {
  throw new Error(`Desktop UI initial build failed with exit code ${initialBuild.exitCode}`);
}

const watchProcess = Bun.spawn(
  ["bun", "build", entrypoint, "--outdir", distDir, "--target", "browser", "--watch"],
  {
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const server = Bun.serve({
  hostname: DEV_HOSTNAME,
  port: DEV_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const file = Bun.file(toFilePath(url.pathname));

    if (file.size > 0) {
      return new Response(file);
    }

    if (!url.pathname.startsWith("/assets/")) {
      return new Response(Bun.file(join(distDir, "index.html")));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Desktop UI dev server ready at http://${DEV_HOSTNAME}:${DEV_PORT}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Stopping desktop UI dev server (${signal})`);
  server.stop(true);
  watchProcess.kill();
  await watchProcess.exited;
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await watchProcess.exited;
