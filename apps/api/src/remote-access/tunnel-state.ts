import type { TunnelMode } from '@briefroom/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { trustedOrigins } from '../auth/origin.middleware.ts';
import { ENV, type Env } from '../config/env.ts';

export interface ActiveTunnel {
  mode: TunnelMode;
  publicUrl: string;
}

/**
 * The one source of the install's active public address: the tunnel's address while a tunnel is
 * up, BRIEFROOM_PUBLIC_URL otherwise. Links, trusted origins and install info all read it here.
 */
@Injectable()
export class TunnelState {
  private active: ActiveTunnel | null = null;
  private forwarding: TunnelMode | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  publicUrl(): string {
    return this.active?.publicUrl ?? this.env.publicUrl;
  }

  /** BRIEFROOM_PUBLIC_URL stays trusted while a tunnel runs, so local and LAN sign-in keep working. */
  origins(): string[] {
    const origins = trustedOrigins(this.env);
    if (this.active) origins.push(new URL(this.active.publicUrl).origin);
    return [...new Set(origins)];
  }

  activeMode(): TunnelMode | null {
    return this.active?.mode ?? null;
  }

  /** Set while a tunnel daemon runs: its requests reach the app from loopback. */
  forwardingMode(): TunnelMode | null {
    return this.forwarding;
  }

  update(active: ActiveTunnel | null, forwarding: TunnelMode | null): void {
    this.active = active;
    this.forwarding = forwarding;
  }
}
