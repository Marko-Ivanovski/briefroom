import { ServiceUnavailableException } from '@nestjs/common';

export const BUSY_RETRY_AFTER_SECONDS = 5;

export class BusyException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'busy', message: 'The server is busy, try again shortly' });
  }
}

/** Runs at most `limit` jobs at once and queues up to `maxQueue` more. Past that it refuses at once. */
export class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new BusyException();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
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
}
