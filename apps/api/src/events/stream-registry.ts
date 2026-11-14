import { Injectable } from '@nestjs/common';

export const HEARTBEAT_MS = 25_000;
export const MAX_PENDING_BYTES = 256 * 1024;
export const MAX_STREAMS_PER_USER = 5;

/** The part of a ServerResponse a stream uses, so tests can stand in for it. */
export interface StreamTarget {
  readonly writableLength: number;
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
  private closed = false;

  constructor(
    snapshot: StreamSnapshot,
    private readonly res: StreamTarget,
    private readonly onClose: (stream: OpenStream) => void,
  ) {
    this.workspaceId = snapshot.workspaceId;
    this.userId = snapshot.userId;
    this.visible =
      snapshot.visibleProjectIds === 'all' ? 'all' : new Set(snapshot.visibleProjectIds);
    this.timer = setInterval(() => this.write(': heartbeat\n\n'), HEARTBEAT_MS);
    this.timer.unref();
  }

  canSee(projectId: string | undefined): boolean {
    return projectId === undefined || this.visible === 'all' || this.visible.has(projectId);
  }

  send(frame: string): void {
    this.write(frame);
  }

  private write(frame: string): void {
    if (this.closed) return;
    try {
      this.res.write(frame);
    } catch {
      this.close();
      return;
    }
    // A client that stopped reading must not make the server queue events for it without limit.
    if (this.res.writableLength > MAX_PENDING_BYTES) this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.onClose(this);
    try {
      this.res.end();
    } catch {
      this.res.destroy();
    }
  }
}

@Injectable()
export class StreamRegistry {
  private readonly byWorkspace = new Map<string, Set<OpenStream>>();

  /** Returns undefined at the per-user cap. Nothing awaits between the check and the add. */
  open(snapshot: StreamSnapshot, res: StreamTarget): OpenStream | undefined {
    if (this.count(snapshot.workspaceId, snapshot.userId) >= MAX_STREAMS_PER_USER) return undefined;
    const stream = new OpenStream(snapshot, res, (s) => this.remove(s));
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
    for (const s of this.streamsOf(workspaceId)) {
      if (s.userId === userId && (projectId === undefined || s.canSee(projectId))) s.close();
    }
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
