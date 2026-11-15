import { Injectable } from '@nestjs/common';

export const HEARTBEAT_MS = 25_000;
export const MAX_PENDING_BYTES = 256 * 1024;
export const MAX_STREAMS_PER_USER = 5;
/** A stream ends after this long, so the client's reconnect checks its session again (R136). */
export const MAX_STREAM_LIFETIME_MS = 30 * 60_000;
/** How long a revocation is remembered for a connect that was in flight when it happened. */
const REVOCATION_MEMORY_MS = 60_000;
const DESTROY_DELAY_MS = 1000;

/** The part of a ServerResponse a stream uses, so tests can stand in for it. */
export interface StreamTarget {
  readonly writableLength: number;
  readonly destroyed: boolean;
  readonly socket?: { destroy(): unknown } | null;
  write(chunk: string): unknown;
  end(): unknown;
  destroy(): unknown;
}

/** Who is listening and what they could see when they connected. */
export interface StreamSnapshot {
  workspaceId: string;
  userId: string;
  visibleProjectIds: 'all' | readonly string[];
}

/**
 * One open SSE connection. The visibility snapshot is taken at connect and never refreshed: a
 * change of role or project membership closes the stream, and the client reconnects (R122).
 */
export class OpenStream {
  readonly workspaceId: string;
  readonly userId: string;
  private readonly visible: 'all' | ReadonlySet<string>;
  private readonly timer: NodeJS.Timeout;
  private readonly lifetime: NodeJS.Timeout;
  private closed = false;

  constructor(
    snapshot: StreamSnapshot,
    private readonly res: StreamTarget,
    private readonly onClose: (stream: OpenStream) => void,
    maxLifetimeMs: number = MAX_STREAM_LIFETIME_MS,
  ) {
    this.workspaceId = snapshot.workspaceId;
    this.userId = snapshot.userId;
    this.visible =
      snapshot.visibleProjectIds === 'all' ? 'all' : new Set(snapshot.visibleProjectIds);
    this.timer = setInterval(() => this.write(': heartbeat\n\n'), HEARTBEAT_MS);
    this.timer.unref();
    this.lifetime = setTimeout(() => this.close(), maxLifetimeMs);
    this.lifetime.unref();
  }

  canSee(projectId: string | undefined): boolean {
    return projectId === undefined || this.visible === 'all' || this.visible.has(projectId);
  }

  send(frame: string): void {
    this.write(frame);
  }

  private write(frame: string): void {
    if (this.closed) return;
    if (this.res.destroyed) {
      this.close(true);
      return;
    }
    try {
      this.res.write(frame);
    } catch {
      this.close(true);
      return;
    }
    // A client that stopped reading must not make the server queue events for it without limit.
    // Ending would wait for it to read, so the socket is destroyed at once.
    if (this.res.writableLength > MAX_PENDING_BYTES) this.close(true);
  }

  /** Ends the response, then destroys the socket after a second so a silent client cannot keep it. */
  close(immediate = false): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.lifetime);
    this.onClose(this);
    if (immediate) {
      this.res.destroy();
      return;
    }
    // Node detaches the socket from the response once it has finished, so it is captured first.
    const socket = this.res.socket;
    try {
      this.res.end();
    } catch {
      this.res.destroy();
      return;
    }
    setTimeout(() => {
      this.res.destroy();
      socket?.destroy();
    }, DESTROY_DELAY_MS).unref();
  }
}

@Injectable()
export class StreamRegistry {
  private readonly byWorkspace = new Map<string, Set<OpenStream>>();
  /** Settable so tests can shorten it. */
  maxLifetimeMs = MAX_STREAM_LIFETIME_MS;
  private epoch = 0;
  private readonly revoked = new Map<string, { epoch: number; at: number }>();

  /** Read before the scope is, and passed to `revokedSince` after the stream is registered (R135). */
  currentEpoch(): number {
    return this.epoch;
  }

  /** True when this user's access in the workspace, or their sessions, were revoked after `epoch`. */
  revokedSince(epoch: number, workspaceId: string, userId: string): boolean {
    return (
      (this.revoked.get(key(workspaceId, userId))?.epoch ?? 0) > epoch ||
      (this.revoked.get(key(undefined, userId))?.epoch ?? 0) > epoch
    );
  }

  private noteRevoked(workspaceId: string | undefined, userId: string): void {
    const now = Date.now();
    for (const [k, v] of this.revoked)
      if (now - v.at > REVOCATION_MEMORY_MS) this.revoked.delete(k);
    this.revoked.set(key(workspaceId, userId), { epoch: ++this.epoch, at: now });
  }

  /** Returns undefined at the per-user cap. Nothing awaits between the check and the add. */
  open(snapshot: StreamSnapshot, res: StreamTarget): OpenStream | undefined {
    if (this.count(snapshot.workspaceId, snapshot.userId) >= MAX_STREAMS_PER_USER) return undefined;
    const stream = new OpenStream(snapshot, res, (s) => this.remove(s), this.maxLifetimeMs);
    let set = this.byWorkspace.get(snapshot.workspaceId);
    if (!set) this.byWorkspace.set(snapshot.workspaceId, (set = new Set()));
    set.add(stream);
    return stream;
  }

  count(workspaceId: string, userId: string): number {
    let n = 0;
    for (const s of this.byWorkspace.get(workspaceId) ?? []) if (s.userId === userId) n++;
    return n;
  }

  streamsOf(workspaceId: string): OpenStream[] {
    return [...(this.byWorkspace.get(workspaceId) ?? [])];
  }

  /** Ends the user's streams in the workspace: all of them, or those whose snapshot includes the project. */
  closeFor(workspaceId: string, userId: string, projectId?: string): void {
    this.noteRevoked(workspaceId, userId);
    for (const s of this.streamsOf(workspaceId)) {
      if (s.userId === userId && (projectId === undefined || s.canSee(projectId))) s.close();
    }
  }

  /** Ends every stream of the user in every workspace: their sessions are gone. */
  closeUser(userId: string): void {
    this.noteRevoked(undefined, userId);
    for (const set of [...this.byWorkspace.values()]) {
      for (const s of [...set]) if (s.userId === userId) s.close();
    }
  }

  /** Ends every stream of one workspace, so its clients reconnect and refetch. */
  closeWorkspace(workspaceId: string): void {
    for (const s of this.streamsOf(workspaceId)) s.close();
  }

  closeAll(): void {
    for (const set of [...this.byWorkspace.values()]) for (const s of [...set]) s.close();
  }

  private remove(stream: OpenStream): void {
    const set = this.byWorkspace.get(stream.workspaceId);
    set?.delete(stream);
    if (set?.size === 0) this.byWorkspace.delete(stream.workspaceId);
  }
}

const key = (workspaceId: string | undefined, userId: string): string =>
  `${workspaceId ?? '*'}:${userId}`;
