import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface CliStateData {
  currentGroupFolder?: string;
}

export class CliStateStore {
  constructor(
    private readonly filePath = join(homedir(), ".octo", "cli-state.json"),
  ) {}

  getCurrentGroupFolder(): string | null {
    const state = this.read();
    return state.currentGroupFolder?.trim() || null;
  }

  setCurrentGroupFolder(folder: string): void {
    const next: CliStateData = {
      currentGroupFolder: folder,
    };
    this.write(next);
  }

  clear(): void {
    this.write({});
  }

  private read(): CliStateData {
    const resolvedPath = resolve(this.filePath);
    if (!existsSync(resolvedPath)) {
      return {};
    }

    try {
      const raw = readFileSync(resolvedPath, "utf-8");
      return JSON.parse(raw) as CliStateData;
    } catch {
      return {};
    }
  }

  private write(state: CliStateData): void {
    const resolvedPath = resolve(this.filePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, JSON.stringify(state, null, 2));
  }
}
