import { describe, expect, test } from "bun:test";
import { emitPiSessionShutdown } from "../src/runtime/pi-session-shutdown";

describe("emitPiSessionShutdown", () => {
  test("returns false when no extension runner is present", async () => {
    await expect(emitPiSessionShutdown(undefined)).resolves.toBe(false);
  });

  test("returns false when the runner has no session_shutdown handlers", async () => {
    const extensionRunner = {
      hasHandlers(eventType: string) {
        expect(eventType).toBe("session_shutdown");
        return false;
      },
      emit: async () => {
        throw new Error("emit should not be called");
      },
    };

    await expect(emitPiSessionShutdown(extensionRunner as never)).resolves.toBe(false);
  });

  test("emits session_shutdown when handlers are registered", async () => {
    const emittedEvents: unknown[] = [];
    const extensionRunner = {
      hasHandlers(eventType: string) {
        expect(eventType).toBe("session_shutdown");
        return true;
      },
      async emit(event: unknown) {
        emittedEvents.push(event);
        return undefined;
      },
    };

    await expect(emitPiSessionShutdown(extensionRunner as never)).resolves.toBe(true);
    expect(emittedEvents).toEqual([
      {
        type: "session_shutdown",
      },
    ]);
  });
});
