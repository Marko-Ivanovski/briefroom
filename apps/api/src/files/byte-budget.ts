/** One pool of bytes for every upload body in flight, whether it is being read, waiting or processed. */
export class ByteBudget {
  private reserved = 0;

  constructor(private readonly total: number) {}

  /** Bytes currently reserved. */
  get used(): number {
    return this.reserved;
  }

  /** Returns a release function, or undefined when the bytes do not fit. Release is idempotent. */
  reserve(bytes: number): (() => void) | undefined {
    if (this.reserved + bytes > this.total) return undefined;
    this.reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
    };
  }
}
