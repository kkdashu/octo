import type { ExtensionRunner } from "@mariozechner/pi-coding-agent";

export async function emitPiSessionShutdown(
  extensionRunner: ExtensionRunner | undefined,
): Promise<boolean> {
  if (!extensionRunner?.hasHandlers("session_shutdown")) {
    return false;
  }

  await extensionRunner.emit({
    type: "session_shutdown",
  });
  return true;
}
