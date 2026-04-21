type Waiter = {
  resolve: (release: () => void) => void;
};

export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`AsyncSemaphore limit must be a positive integer: ${limit}`);
    }
  }

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (!next) {
        return;
      }

      this.active += 1;
      next.resolve(this.createRelease());
    };
  }
}
