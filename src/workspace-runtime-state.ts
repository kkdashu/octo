const DEFAULT_IDLE_UNLOAD_MINUTES = 30;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export function getWorkspaceIdleUnloadMinutes(): number {
  return parsePositiveInteger(process.env.OCTO_WORKSPACE_IDLE_UNLOAD_MINUTES)
    ?? parsePositiveInteger(process.env.OCTO_RUNTIME_IDLE_UNLOAD_MINUTES)
    ?? DEFAULT_IDLE_UNLOAD_MINUTES;
}

export function calculateWorkspaceUnloadAfter(now = new Date()): string {
  const idleMinutes = getWorkspaceIdleUnloadMinutes();
  return new Date(now.getTime() + idleMinutes * 60_000).toISOString();
}
