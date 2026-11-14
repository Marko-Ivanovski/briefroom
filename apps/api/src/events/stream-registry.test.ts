import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_MS,
  MAX_PENDING_BYTES,
  StreamRegistry,
  type StreamTarget,
} from './stream-registry.ts';

type Fake = { -readonly [K in keyof StreamTarget]: StreamTarget[K] } & {
  written: string[];
  ended: boolean;
};

function fakeResponse(): Fake {
  const res = {
    written: [] as string[],
    ended: false,
    writableLength: 0,
    write(chunk: string) {
      res.written.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
    },
    destroy() {
      res.ended = true;
    },
  };
  return res;
}

const snapshot = (visible: 'all' | string[]) => ({
  workspaceId: 'w',
  userId: 'u',
  visibleProjectIds: visible,
});

describe('StreamRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a heartbeat comment every 25 seconds and stops after close', () => {
    expect(HEARTBEAT_MS).toBe(25_000);
    const registry = new StreamRegistry();
    const res = fakeResponse();
    const stream = registry.open(snapshot('all'), res)!;
    expect(res.written).toEqual([]);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(res.written).toEqual([': heartbeat\n\n']);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(res.written).toHaveLength(2);
    stream.close();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(res.written).toHaveLength(2);
    expect(registry.count('w', 'u')).toBe(0);
  });

  it('closes a stream whose pending writes pass 256 KB, and keeps one below it', () => {
    const registry = new StreamRegistry();
    const slow = fakeResponse();
    const fine = fakeResponse();
    const a = registry.open(snapshot('all'), slow)!;
    const b = registry.open({ ...snapshot('all'), userId: 'v' }, fine)!;
    slow.writableLength = MAX_PENDING_BYTES + 1;
    fine.writableLength = MAX_PENDING_BYTES;
    a.send('data\n\n');
    b.send('data\n\n');
    expect(slow.ended).toBe(true);
    expect(registry.count('w', 'u')).toBe(0);
    expect(fine.ended).toBe(false);
    expect(registry.count('w', 'v')).toBe(1);
  });

  it('refuses a sixth stream for the same user and workspace only', () => {
    const registry = new StreamRegistry();
    for (let i = 0; i < 5; i++)
      expect(registry.open(snapshot('all'), fakeResponse())).toBeDefined();
    expect(registry.open(snapshot('all'), fakeResponse())).toBeUndefined();
    expect(registry.open({ ...snapshot('all'), workspaceId: 'x' }, fakeResponse())).toBeDefined();
  });

  it('treats the snapshot as the whole truth: all, or the listed projects', () => {
    const registry = new StreamRegistry();
    const all = registry.open(snapshot('all'), fakeResponse())!;
    const some = registry.open({ ...snapshot(['p1']), userId: 'v' }, fakeResponse())!;
    expect(all.canSee('p9')).toBe(true);
    expect(some.canSee('p1')).toBe(true);
    expect(some.canSee('p9')).toBe(false);
    expect(some.canSee(undefined)).toBe(true);
  });
});
