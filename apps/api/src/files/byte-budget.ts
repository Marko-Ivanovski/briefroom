/** One pool of bytes for every upload body in flight, whether it is being read, waiting or processed. */
export class ByteBudget {
  private used = 0;

  constructor(private readonly total: number) {}

  /** Returns a release function, or undefined when the bytes do not fit. Release is idempotent. */
  reserve(bytes: number): (() => void) | undefined {
    if (this.used + bytes > this.total) return undefined;
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
    };
  }
}
