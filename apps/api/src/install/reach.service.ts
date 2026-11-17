import type { InstallReach } from '@briefroom/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.ts';
import { TunnelState } from '../remote-access/tunnel-state.ts';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

/**
 * How people can reach this install. A running tunnel wins. Otherwise the install is `lan` when
 * the port is published beyond loopback or BRIEFROOM_PUBLIC_URL names another host (the owner's
 * own reverse proxy), and `local` when both are loopback.
 */
@Injectable()
export class ReachService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly tunnel: TunnelState,
  ) {}

  current(): InstallReach {
    const mode = this.tunnel.activeMode();
    if (mode) return mode;
    const local =
      LOOPBACK.test(this.env.bind) && LOOPBACK.test(new URL(this.env.publicUrl).hostname);
    return local ? 'local' : 'lan';
  }

  isReachableByOthers(): boolean {
    return this.current() !== 'local';
  }
}
