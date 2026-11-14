import { ServiceUnavailableException } from '@nestjs/common';

export const BUSY_RETRY_AFTER_SECONDS = 5;

/** The server is at capacity for this kind of work. The filter adds the Retry-After header. */
export class BusyException extends ServiceUnavailableException {
  constructor() {
    super({ code: 'busy', message: 'The server is busy, try again shortly' });
  }
}
