import type { InstallReach } from '@briefroom/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.ts';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

/**
 * How people can reach this install. Only the port binding is known here: a loopback bind is
 * `local`, anything else (0.0.0.0 or a LAN address) is `lan`. A tunnel mode overrides this later.
 */
@Injectable()
export class ReachService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  current(): InstallReach {
    return LOOPBACK.test(this.env.bind) ? 'local' : 'lan';
  }

  isReachableByOthers(): boolean {
    return this.current() !== 'local';
  }
}
