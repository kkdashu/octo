import type { AgentProvider } from "./types";
import { log } from "../logger";

const TAG = "provider-registry";

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();
  private defaultName: string | null = null;

  register(provider: AgentProvider): void {
    this.providers.set(provider.name, provider);
    if (!this.defaultName) {
      this.defaultName = provider.name;
    }
    log.info(TAG, `Registered provider: ${provider.name}`);
  }

  get(name: string): AgentProvider | undefined {
    return this.providers.get(name);
  }

  getDefault(): AgentProvider {
    if (!this.defaultName) {
      throw new Error("No providers registered");
    }
    return this.providers.get(this.defaultName)!;
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider not found: ${name}`);
    }
    this.defaultName = name;
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}
