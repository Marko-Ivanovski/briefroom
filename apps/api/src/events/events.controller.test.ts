import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '../access/scope.ts';
import { EventsController } from './events.controller.ts';
import type { EventsListener } from './events-listener.ts';
import { STREAM_EPOCH } from './stream-epoch.middleware.ts';
import { StreamRegistry } from './stream-registry.ts';

const scope = {
  userId: 'u',
  workspaceId: 'w',
  role: 'member',
  visibleProjectIds: [],
  permissions: new Set(),
  actor: { userId: 'u', via: 'web' },
} as Scope;

function pair(epoch?: number) {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    setTimeout: vi.fn(),
    setNoDelay: vi.fn(),
    setKeepAlive: vi.fn(),
  });
  const req = Object.assign(new EventEmitter(), { socket }) as unknown as IncomingMessage;
  if (epoch !== undefined) (req as unknown as Record<symbol, number>)[STREAM_EPOCH] = epoch;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }) as unknown as ServerResponse;
  return { req, res, socket };
}

const up = { isUp: () => true } as EventsListener;

describe('EventsController', () => {
  it('fails closed when the request carries no epoch', () => {
    const registry = new StreamRegistry();
    const { req, res } = pair();
    new EventsController(registry, up).stream(scope, req, res);
    expect(registry.count('w', 'u')).toBe(0);
    expect(res.end).toHaveBeenCalled();
  });

  it('keeps the stream when the epoch is present and nothing was revoked', () => {
    const registry = new StreamRegistry();
    const { req, res } = pair(registry.currentEpoch());
    new EventsController(registry, up).stream(scope, req, res);
    expect(registry.count('w', 'u')).toBe(1);
    registry.closeAll();
  });

  it('closes at once when the socket is already destroyed', () => {
    const registry = new StreamRegistry();
    const { req, res, socket } = pair(registry.currentEpoch());
    socket.destroyed = true;
    new EventsController(registry, up).stream(scope, req, res);
    expect(registry.count('w', 'u')).toBe(0);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('refuses with 503 events_unavailable while the listener is down', () => {
    const registry = new StreamRegistry();
    const { req, res } = pair(registry.currentEpoch());
    expect(() =>
      new EventsController(registry, { isUp: () => false } as EventsListener).stream(
        scope,
        req,
        res,
      ),
    ).toThrow(expect.objectContaining({ status: 503 }));
  });
});
