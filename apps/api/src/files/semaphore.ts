import { BusyException } from '../errors/busy.ts';

/**
 * Runs at most `limit` jobs at once and queues up to `maxQueue` more. Past that it refuses at once.
 * With `maxWaitMs`, a job that waited that long in the queue is refused too.
 */
export class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
    private readonly maxWaitMs?: number,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new BusyException();
      await this.wait();
    } else {
      this.running += 1;
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  /** Resolves when a finishing job hands its slot over, which is then already counted as running. */
  private wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer =
        this.maxWaitMs === undefined
          ? undefined
          : setTimeout(() => {
              const at = this.waiting.indexOf(turn);
              if (at === -1) return;
              this.waiting.splice(at, 1);
              reject(new BusyException());
            }, this.maxWaitMs);
      this.waiting.push(turn);
    });
  }
}
