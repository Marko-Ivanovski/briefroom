import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import type {
  RemoteAccessSettings,
  RemoteAccessStatus,
  RemoteAccessUpdate,
  TunnelMode,
} from '@briefroom/contracts';
import { createdStamp, remoteAccess, updatedStamp, type Actor, type Db } from '@briefroom/db';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';
import { describeError } from '../errors/safe-error.ts';
import { deriveSecretBoxKey, open, seal } from './secret-box.ts';
import { Supervisor, type SupervisorSnapshot } from './supervisor.ts';
import { TunnelState, type ActiveTunnel } from './tunnel-state.ts';

const SYSTEM: Actor = { userId: 'system', via: 'system' };
const UNREADABLE_SECRET =
  'The stored secret could not be read with BRIEFROOM_SECRET_KEY. Enter it again.';

type Row = typeof remoteAccess.$inferSelect;

const provider = (mode: string): string => (mode === 'cloudflare' ? 'cloudflare' : 'tailscale');

/** The tunnel the database says is up. For processes without a supervisor, such as the host CLI. */
export async function readActiveTunnel(db: Db): Promise<ActiveTunnel | null> {
  const [row] = await db
    .select()
    .from(remoteAccess)
    .where(and(ne(remoteAccess.mode, 'off'), eq(remoteAccess.status, 'running')));
  if (!row?.publicUrl || row.mode === 'off') return null;
  return { mode: row.mode, publicUrl: row.publicUrl };
}

@Injectable()
export class RemoteAccessService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('RemoteAccess');
  private readonly key: Buffer;
  private readonly stateDir: string;
  private publicUrl: string | null = null;
  private socketError: string | null = null;
  // Status writes run one after another, so a late write can never overwrite a newer one.
  private writes: Promise<void> = Promise.resolve();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) env: Env,
    private readonly supervisor: Supervisor,
    private readonly tunnel: TunnelState,
  ) {
    this.key = deriveSecretBoxKey(env.secretKey);
    this.stateDir = supervisorStateDir(env);
    supervisor.subscribe((snapshot) => this.apply(snapshot));
  }

  async onApplicationBootstrap(): Promise<void> {
    const row = await this.row();
    if (!row || row.mode === 'off' || !row.secretCiphertext || !row.publicUrl) return;
    let secret: string;
    try {
      secret = open(row.secretCiphertext, this.key);
    } catch {
      this.logger.warn(UNREADABLE_SECRET);
      this.write('error', UNREADABLE_SECRET);
      return;
    }
    this.launch(row.mode, secret, row.publicUrl);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.supervisor.stop();
    await this.writes;
  }

  /** Tunnels forward to the socket, so without it a tunnel can never work. The app itself keeps serving. */
  async tunnelSocketUnavailable(message: string): Promise<void> {
    this.socketError = message;
    const row = await this.row();
    if (!row || row.mode === 'off') return;
    await this.supervisor.stop();
    this.write('error', message);
  }

  async settings(): Promise<RemoteAccessSettings> {
    await this.writes;
    const row = await this.row();
    return {
      mode: row?.mode ?? 'off',
      publicUrl: row?.publicUrl ?? null,
      status: row?.status ?? 'off',
      lastError: row?.lastError ?? null,
      hasSecret: !!row?.secretCiphertext,
    };
  }

  async update(actor: Actor, input: RemoteAccessUpdate): Promise<RemoteAccessSettings> {
    const row = await this.row();
    if (input.mode === 'off') {
      await this.save(actor, {
        mode: 'off',
        secretCiphertext: null,
        publicUrl: row?.publicUrl ?? null,
        status: 'off',
      });
      await this.supervisor.stop();
      return this.settings();
    }
    const publicUrl = validPublicUrl(input.mode, input.publicUrl);
    const secret = input.secret ?? this.storedSecretFor(input.mode, row);
    await this.save(actor, {
      mode: input.mode,
      secretCiphertext: seal(secret, this.key),
      publicUrl,
      status: 'starting',
    });
    this.launch(input.mode, secret, publicUrl);
    return this.settings();
  }

  private launch(mode: TunnelMode, secret: string, publicUrl: string): void {
    if (this.socketError) {
      this.write('error', this.socketError);
      return;
    }
    this.publicUrl = publicUrl;
    if (mode !== 'cloudflare') {
      try {
        mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      } catch (err) {
        this.logger.warn(`Could not create ${this.stateDir}: ${describeError(err)}`);
      }
    }
    this.supervisor.start(mode, secret);
  }

  private storedSecretFor(mode: TunnelMode, row: Row | undefined): string {
    if (row?.secretCiphertext && row.mode !== 'off' && provider(row.mode) === provider(mode)) {
      try {
        return open(row.secretCiphertext, this.key);
      } catch {
        throw new BadRequestException(UNREADABLE_SECRET);
      }
    }
    throw new BadRequestException(
      mode === 'cloudflare'
        ? 'secret is required: paste the tunnel token from the Cloudflare dashboard'
        : 'secret is required: paste a Tailscale auth key',
    );
  }

  private apply(snapshot: SupervisorSnapshot): void {
    const active =
      snapshot.mode && snapshot.status === 'running' && this.publicUrl
        ? { mode: snapshot.mode, publicUrl: this.publicUrl }
        : null;
    this.tunnel.update(active, snapshot.forwarding ? snapshot.mode : null);
    if (snapshot.mode || snapshot.status === 'off') {
      this.write(snapshot.status, snapshot.lastError);
    }
  }

  private write(status: RemoteAccessStatus, lastError: string | null): void {
    this.writes = this.writes
      .then(async () => {
        await this.db
          .update(remoteAccess)
          .set({ status, lastError, ...updatedStamp(SYSTEM) })
          .where(eq(remoteAccess.singleton, true));
      })
      .catch((err: unknown) => {
        this.logger.warn(`Could not record the remote access status: ${describeError(err)}`);
      });
  }

  private async save(
    actor: Actor,
    values: Pick<Row, 'mode' | 'secretCiphertext' | 'publicUrl' | 'status'>,
  ): Promise<void> {
    await this.writes;
    await this.db
      .insert(remoteAccess)
      .values({ ...values, lastError: null, ...createdStamp(actor) })
      .onConflictDoUpdate({
        target: remoteAccess.singleton,
        set: { ...values, lastError: null, ...updatedStamp(actor) },
      });
  }

  private async row(): Promise<Row | undefined> {
    const [row] = await this.db.select().from(remoteAccess);
    return row;
  }
}

export function supervisorStateDir(env: Env): string {
  return `${env.dataDir.replace(/[\\/]+$/, '')}/tailscale`;
}

function validPublicUrl(mode: TunnelMode, raw: string | undefined): string {
  if (!raw) throw new BadRequestException('publicUrl is required to switch remote access on');
  const url = new URL(raw);
  if (url.protocol !== 'https:')
    throw new BadRequestException('publicUrl must be an https address');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new BadRequestException('publicUrl must be the bare address, with no path or query');
  }
  if (!isPlainHost(url.hostname)) {
    throw new BadRequestException('publicUrl must name one host: DNS labels or an IP, no wildcard');
  }
  if (mode !== 'cloudflare' && url.port !== '' && url.port !== '443') {
    throw new BadRequestException(
      'Tailscale serves Briefroom on port 443, so publicUrl must use 443',
    );
  }
  return url.origin;
}

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// Better Auth reads `*` in a trusted origin as a wildcard, so the address must be one exact host.
function isPlainHost(hostname: string): boolean {
  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return true;
  const labels = hostname.split('.');
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
}
