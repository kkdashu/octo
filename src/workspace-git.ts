import { spawnSync } from "node:child_process";

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

function runGit(
  cwd: string,
  args: string[],
): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function runGitOrThrow(
  cwd: string,
  args: string[],
): string {
  const result = runGit(cwd, args);
  if (result.ok) {
    return result.stdout;
  }

  const detail = result.stderr || result.stdout || `git ${args.join(" ")} failed`;
  throw new Error(detail);
}

export function getCurrentWorkspaceBranch(workspaceDir: string): string {
  const symbolicRef = runGit(workspaceDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolicRef.ok && symbolicRef.stdout) {
    return symbolicRef.stdout;
  }

  return "main";
}

export function listWorkspaceBranches(workspaceDir: string): string[] {
  const listed = runGit(workspaceDir, ["branch", "--format=%(refname:short)"]);
  const branches = listed.ok
    ? listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    : [];

  const current = getCurrentWorkspaceBranch(workspaceDir);
  if (!branches.includes(current)) {
    branches.unshift(current);
  }

  return [...new Set(branches)];
}

export function workspaceBranchExists(
  workspaceDir: string,
  branch: string,
): boolean {
  return listWorkspaceBranches(workspaceDir).includes(branch);
}

export function isWorkspaceDirty(workspaceDir: string): boolean {
  const status = runGit(workspaceDir, ["status", "--porcelain"]);
  if (!status.ok) {
    return false;
  }

  return status.stdout.length > 0;
}

export function checkoutWorkspaceBranch(
  workspaceDir: string,
  branch: string,
): void {
  if (workspaceBranchExists(workspaceDir, branch)) {
    runGitOrThrow(workspaceDir, ["checkout", branch]);
    return;
  }

  runGitOrThrow(workspaceDir, ["checkout", "-b", branch]);
}

export function createWorkspaceBranch(
  workspaceDir: string,
  branch: string,
  startPoint?: string,
): void {
  if (workspaceBranchExists(workspaceDir, branch)) {
    throw new Error(`Branch already exists: ${branch}`);
  }

  const args = startPoint
    ? ["branch", branch, startPoint]
    : ["branch", branch];
  runGitOrThrow(workspaceDir, args);
}
