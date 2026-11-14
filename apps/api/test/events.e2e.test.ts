import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Global, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { memberPermissions, scopedInsert } from '@briefroom/db';
import { systemScope, type Scope } from '@briefroom/module-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.ts';
import { DatabaseModule } from '../src/database/database.module.ts';
import { EnvModule } from '../src/config/env.module.ts';
import { EventsModule } from '../src/events/events.module.ts';
import { EventsService, MAX_EVENT_BYTES } from '../src/events/events.service.ts';
import { EVENTS, JOBS, type EventPublisher, type JobQueue } from '@briefroom/module-kit';
import { TestkitModule } from '@briefroom/module-testkit/server';
import { RevocationService } from '../src/members/revocation.service.ts';
import { EventsListener } from '../src/events/events-listener.ts';
import { AccessService } from '../src/access/access.service.ts';
import { MAX_STREAM_LIFETIME_MS, StreamRegistry } from '../src/events/stream-registry.ts';
import { ModuleRegistryService } from '../src/module-registry/module-registry.service.ts';
import { WorkspaceModulesService } from '../src/module-registry/workspace-modules.service.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';

interface Frame {
  event?: string;
  data?: string;
  comment?: string;
}

interface Sse {
  status: number;
  headers: Headers;
  body: unknown;
  frames: Frame[];
  ended: Promise<void>;
  abort(): void;
  next(match: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  has(type: string): boolean;
}

describe('workspace event stream', () => {
  let t: TestApp;
  let base: string;
  let ws: string;
  let projectId: string;
  let otherProjectId: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const open: Sse[] = [];

  const api = (path: string) => `${base}/api/v1/workspaces/${ws}${path}`;
  const json = (who: string, body?: unknown) => ({
    headers: { cookie: cookies[who]!, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctl = (): Scope => systemScope(ws);

  async function connect(who: string, workspace = ws): Promise<Sse> {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/workspaces/${workspace}/events`, {
      headers: { cookie: cookies[who]! },
      signal: controller.signal,
    });
    const frames: Frame[] = [];
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const sse: Sse = {
      status: res.status,
      headers: res.headers,
      body: undefined,
      frames,
      ended,
      abort: () => controller.abort(),
      has: (type) => frames.some((f) => f.event === type),
      async next(match, ms = 4000) {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = frames.find(match);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error('timed out waiting for a frame');
          await new Promise((r) => setTimeout(r, 15));
        }
      },
    };
    if (!res.ok || !res.body) {
      sse.body = await res.json().catch(() => undefined);
      end();
      return sse;
    }
    open.push(sse);
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame: Frame = {};
            for (const line of buffer.slice(0, cut).split('\n')) {
              if (line.startsWith('event: ')) frame.event = line.slice(7);
              else if (line.startsWith('data: ')) frame.data = line.slice(6);
              else if (line.startsWith(':')) frame.comment = line.slice(1).trim();
            }
            buffer = buffer.slice(cut + 2);
            frames.push(frame);
          }
        }
      } catch {
        // aborted
      }
      end();
    })();
    await sse.next((f) => f.comment === 'open');
    return sse;
  }

  /** A workspace-level event after which everything published earlier has been dispatched. */
  async function flush(streams: Sse[]): Promise<void> {
    const type = `testkit.flush_${Math.random().toString(36).slice(2)}`;
    await t.app.get(EventsService).publish(ctl(), { type });
    for (const s of streams) await s.next((f) => f.event === type);
  }

  const note = (who: string, projectId?: string) =>
    fetch(api('/m/testkit/notes'), {
      method: 'POST',
      ...json(who, { text: 'hello', ...(projectId ? { projectId } : {}) }),
    });

  async function addUser(key: string): Promise<void> {
    const email = `${key}@example.com`;
    const { user } = await t.auth.api.createUser({
      body: { email, password: PASSWORD, name: key },
    });
    ids[key] = user.id;
    const res = await t.auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    cookies[key] = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  beforeAll(async () => {
    t = await createTestApp();
    // Node only checks requestTimeout on its connection sweep, so both are made short for the test.
    const server = t.app.getHttpServer();
    server.requestTimeout = 300;
    server.connectionsCheckingInterval = 50;
    // A socket idle timeout is the one that would cut a quiet stream, so the route must clear it.
    server.setTimeout(300);
    await t.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const key of [
      'owner',
      'admin',
      'onP',
      'offP',
      'outsider',
      'joiner',
      'racer',
      'resetter',
      'signer',
      'signer2',
      'aborter',
      'creator',
    ])
      await addUser(key);
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    await t.auth.api.addMember({ body: { userId: ids.admin!, role: 'admin', organizationId: ws } });
    for (const key of [
      'onP',
      'offP',
      'joiner',
      'racer',
      'resetter',
      'signer',
      'signer2',
      'aborter',
      'creator',
    ]) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role: 'member', organizationId: ws },
      });
    }
    const actor = { userId: ids.owner!, via: 'web' } as const;
    await t.app.get(WorkspaceModulesService).enableStarting(ws, actor, ['testkit']);

    const make = async (name: string): Promise<string> => {
      const res = await fetch(api('/projects'), { method: 'POST', ...json('owner', { name }) });
      return ((await res.json()) as { id: string }).id;
    };
    projectId = await make('P');
    otherProjectId = await make('Q');
    for (const key of ['onP']) {
      const res = await fetch(api(`/projects/${projectId}/members`), {
        method: 'POST',
        ...json('owner', { userId: ids[key] }),
      });
      expect(res.status).toBe(201);
    }
    await t.db.db
      .insert(memberPermissions)
      .values(
        scopedInsert(
          { workspaceId: ws, actor },
          { userId: ids.onP!, moduleId: 'testkit', key: 'write-notes' },
        ),
      );
  });

  afterAll(async () => {
    for (const s of open) s.abort();
    await t.close();
  });

  it('streams with the SSE headers and a heartbeat-ready open comment', async () => {
    const s = await connect('onP');
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('text/event-stream');
    expect(s.headers.get('cache-control')).toBe('no-store');
    expect(s.headers.get('x-accel-buffering')).toBe('no');
    s.abort();
  });

  it('answers 404 to a non-member and 401 to an anonymous caller', async () => {
    expect((await connect('outsider')).status).toBe(404);
    expect((await fetch(`${base}/api/v1/workspaces/${ws}/events`)).status).toBe(401);
  });

  it('delivers a project event to a member on the project and not to one who is off it', async () => {
    const on = await connect('onP');
    const off = await connect('offP');
    const admin = await connect('admin');
    const res = await note('onP', projectId);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const frame = await on.next((f) => f.event === 'testkit.note_created');
    expect(JSON.parse(frame.data!)).toMatchObject({
      workspaceId: ws,
      projectId,
      type: 'testkit.note_created',
      payload: { noteId: created.id },
    });
    await admin.next((f) => f.event === 'testkit.note_created');
    await flush([on, off, admin]);
    expect(off.has('testkit.note_created')).toBe(false);
    for (const s of [on, off, admin]) s.abort();
  });

  it('delivers a workspace-level event to everyone, and a project event only for visible projects', async () => {
    const on = await connect('onP');
    const off = await connect('offP');
    const events = t.app.get(EventsService);
    await events.publish(ctl(), { type: 'testkit.workspace_level' });
    await events.publish(ctl(), { type: 'testkit.on_q', projectId: otherProjectId });
    await flush([on, off]);
    expect(on.has('testkit.workspace_level')).toBe(true);
    expect(off.has('testkit.workspace_level')).toBe(true);
    expect(on.has('testkit.on_q')).toBe(false);
    for (const s of [on, off]) s.abort();
  });

  it('delivers an event published from another process (a worker-mode publisher)', async () => {
    @Global()
    @Module({ providers: [ModuleRegistryService], exports: [ModuleRegistryService] })
    class RegistryOnly {}
    const env = loadEnv({
      DATABASE_URL: t.db.url,
      BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
    });
    @Module({
      imports: [
        EnvModule.register(env),
        DatabaseModule,
        RegistryOnly,
        EventsModule.register('worker'),
      ],
    })
    class WorkerLike {}
    const worker = await NestFactory.createApplicationContext(WorkerLike, { logger: false });
    try {
      const on = await connect('onP');
      await worker
        .get(EventsService)
        .publish(ctl(), { type: 'testkit.from_worker', projectId, payload: { n: 1 } });
      const frame = await on.next((f) => f.event === 'testkit.from_worker');
      expect(JSON.parse(frame.data!)).toMatchObject({ workspaceId: ws, payload: { n: 1 } });
      on.abort();
    } finally {
      await worker.close();
    }
  });

  it('ends a user’s streams on closeFor, and only those that include the project when one is given', async () => {
    const registry = t.app.get(StreamRegistry);
    const onP = await connect('onP');
    const offP = await connect('offP');
    registry.closeFor(ws, ids.offP!, projectId);
    await flush([onP, offP]);
    expect(registry.count(ws, ids.offP!)).toBe(1);
    registry.closeFor(ws, ids.onP!, projectId);
    await onP.ended;
    registry.closeFor(ws, ids.offP!);
    await offP.ended;
    expect(registry.count(ws, ids.onP!)).toBe(0);
    expect(registry.count(ws, ids.offP!)).toBe(0);
  });

  it('drops events typed for a module that is off, checking once per event, not per subscriber', async () => {
    const modules = t.app.get(WorkspaceModulesService);
    const owner = await connect('owner');
    const admin = await connect('admin');
    const spy = vi.spyOn(modules, 'isEnabled');
    const events = t.app.get(EventsService);
    await events.publish(ctl(), { type: 'testkit.while_on' });
    await owner.next((f) => f.event === 'testkit.while_on');
    await admin.next((f) => f.event === 'testkit.while_on');
    expect(spy).toHaveBeenCalledTimes(1);

    const actor = { userId: ids.owner!, via: 'web' } as const;
    await modules.update({ ...ctl(), actor }, 'testkit', { enabled: false });
    spy.mockClear();
    await events.publish(ctl(), { type: 'testkit.while_off' });
    await events.publishCore({ workspaceId: ws, type: 'core.still_on' });
    await owner.next((f) => f.event === 'core.still_on');
    await admin.next((f) => f.event === 'core.still_on');
    expect(owner.has('testkit.while_off')).toBe(false);
    expect(admin.has('testkit.while_off')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    await modules.update({ ...ctl(), actor }, 'testkit', { enabled: true });
    spy.mockRestore();
    owner.abort();
    admin.abort();
  });

  it('closes the workspace streams when the module-off lookup fails, so clients refetch', async () => {
    const modules = t.app.get(WorkspaceModulesService);
    const owner = await connect('owner');
    const admin = await connect('admin');
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(modules, 'isEnabled').mockRejectedValueOnce(new Error('database is down'));
    try {
      await t.app.get(EventsService).publish(ctl(), { type: 'testkit.lookup_fails' });
      await owner.ended;
      await admin.ended;
      expect(owner.has('testkit.lookup_fails')).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Module lookup failed'));
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
    const again = await connect('owner');
    await flush([again]);
    again.abort();
  });

  it('refuses an event over 6 KB at publish, and an unknown or core type from a module', async () => {
    const events = t.app.get(EventsService);
    const big = { blob: 'x'.repeat(MAX_EVENT_BYTES) };
    await expect(events.publish(ctl(), { type: 'testkit.big', payload: big })).rejects.toThrow(
      /6144/,
    );
    await expect(events.publish(ctl(), { type: 'core.nope' })).rejects.toThrow(/core/);
    await expect(events.publish(ctl(), { type: 'ghost.thing' })).rejects.toThrow(/registered/);
    await expect(events.publish(ctl(), { type: 'nodot' })).rejects.toThrow(/event type/);
    const member: Scope = { ...ctl(), role: 'member', visibleProjectIds: [projectId] };
    await expect(
      events.publish(member, { type: 'testkit.x', projectId: otherProjectId }),
    ).rejects.toThrow(/project/);
  });

  it('emits nothing for a rolled-back publish and delivers a committed one', async () => {
    const on = await connect('owner');
    const events = t.app.get(EventsService);
    await expect(
      t.db.db.transaction(async (tx) => {
        await events.publish(ctl(), { type: 'testkit.rolled_back' }, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await t.db.db.transaction(async (tx) => {
      await events.publish(ctl(), { type: 'testkit.committed' }, tx);
    });
    await on.next((f) => f.event === 'testkit.committed');
    expect(on.has('testkit.rolled_back')).toBe(false);
    on.abort();
  });

  it('allows 5 streams per user per workspace and answers the 6th with 429 too_many_streams', async () => {
    const streams: Sse[] = [];
    for (let i = 0; i < 5; i++) streams.push(await connect('offP'));
    const sixth = await connect('offP');
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ code: 'too_many_streams' });
    const other = await connect('onP');
    expect(other.status).toBe(200);
    streams[0]!.abort();
    await vi.waitFor(() => expect(t.app.get(StreamRegistry).count(ws, ids.offP!)).toBe(4));
    const again = await connect('offP');
    expect(again.status).toBe(200);
    for (const s of [...streams, again, other]) s.abort();
    await vi.waitFor(() => expect(t.app.get(StreamRegistry).count(ws, ids.offP!)).toBe(0));
  });

  it('cleans the registry up when the client disconnects', async () => {
    const registry = t.app.get(StreamRegistry);
    const s = await connect('onP');
    expect(registry.count(ws, ids.onP!)).toBe(1);
    s.abort();
    await vi.waitFor(() => expect(registry.count(ws, ids.onP!)).toBe(0));
  });

  it('keeps a quiet stream open past the server requestTimeout and the socket idle timeout', async () => {
    const server = t.app.getHttpServer();
    expect(server.requestTimeout).toBe(300);
    expect(server.timeout).toBe(300);
    const s = await connect('onP');
    await new Promise((r) => setTimeout(r, 1200));
    await t.app.get(EventsService).publish(ctl(), { type: 'testkit.late' });
    await s.next((f) => f.event === 'testkit.late');
    s.abort();
  });

  it('ends the stream when the user’s role changes, and a fresh stream gets a fresh snapshot', async () => {
    const s = await connect('offP');
    const res = await fetch(api(`/members/${ids.offP}`), {
      method: 'PATCH',
      ...json('owner', { role: 'admin' }),
    });
    expect(res.status).toBe(200);
    await s.ended;
    const fresh = await connect('offP');
    await t.app.get(EventsService).publish(ctl(), { type: 'testkit.q', projectId: otherProjectId });
    await fresh.next((f) => f.event === 'testkit.q');
    fresh.abort();
    await fetch(api(`/members/${ids.offP}`), {
      method: 'PATCH',
      ...json('owner', { role: 'member' }),
    });
  });

  it('ends the stream when the member is removed from the project', async () => {
    const s = await connect('onP');
    const res = await fetch(api(`/projects/${projectId}/members/${ids.onP}`), {
      method: 'DELETE',
      ...json('owner'),
    });
    expect(res.status).toBe(204);
    await s.ended;
  });

  it('ends the stream when the member is removed from the workspace', async () => {
    const s = await connect('offP');
    const res = await fetch(api(`/members/${ids.offP}`), { method: 'DELETE', ...json('owner') });
    expect(res.status).toBeLessThan(300);
    await s.ended;
    expect([401, 404]).toContain((await connect('offP')).status);
  });

  it('reconnects its listener with backoff when the connection drops', async () => {
    const owner = await connect('owner');
    const pool = t.db.db.$client;
    await vi.waitFor(async () => {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE application_name = 'briefroom-events' AND datname = current_database()`,
      );
      expect(rowCount).toBe(1);
    });
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'briefroom-events' AND datname = current_database()`,
    );
    await owner.ended;
    const events = t.app.get(EventsService);
    await vi.waitFor(
      async () => {
        const again = await connect('owner');
        try {
          await events.publish(ctl(), { type: 'testkit.after_reconnect' });
          await again.next((f) => f.event === 'testkit.after_reconnect', 500);
        } finally {
          again.abort();
        }
      },
      { timeout: 8000, interval: 300 },
    );
  });

  it('closes a member’s streams when they join a project, and the reconnect sees its events', async () => {
    const before = await connect('joiner');
    const res = await fetch(api(`/projects/${otherProjectId}/members`), {
      method: 'POST',
      ...json('owner', { userId: ids.joiner }),
    });
    expect(res.status).toBe(201);
    await before.ended;
    const after = await connect('joiner');
    await t.app
      .get(EventsService)
      .publish(ctl(), { type: 'testkit.joined', projectId: otherProjectId });
    await after.next((f) => f.event === 'testkit.joined');
    after.abort();
  });

  it('closes a stream whose connect raced a revocation between the scope read and the open', async () => {
    const access = t.app.get(AccessService);
    const registry = t.app.get(StreamRegistry);
    const real = access.scopeFor.bind(access);
    const spy = vi.spyOn(access, 'scopeFor').mockImplementation(async (...args) => {
      const scope = await real(...args);
      if (args[0] === ids.racer) registry.closeFor(ws, ids.racer!);
      return scope;
    });
    try {
      const raced = await connect('racer');
      await raced.ended;
      expect(registry.count(ws, ids.racer!)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const fine = await connect('racer');
    await t.app.get(EventsService).publish(ctl(), { type: 'testkit.after_race' });
    await fine.next((f) => f.event === 'testkit.after_race');
    fine.abort();
  });

  it('closes a user’s streams in every workspace when a password reset revokes their sessions', async () => {
    const s = await connect('resetter');
    const link = await fetch(api(`/members/${ids.resetter}/reset-link`), {
      method: 'POST',
      ...json('owner'),
    });
    expect(link.status).toBeLessThan(300);
    const { url } = (await link.json()) as { url: string };
    const reset = await fetch(`${base}/api/v1/reset/${url.split('/reset/')[1]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'another correct horse' }),
    });
    expect(reset.status).toBeLessThan(300);
    await s.ended;
  });

  it('closes a user’s streams on sign-out', async () => {
    const s = await connect('signer');
    const res = await fetch(`${base}/api/auth/sign-out`, {
      method: 'POST',
      headers: { ...json('signer').headers, origin: 'http://localhost:4300' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await s.ended;
  });

  it('ends a stream after the maximum lifetime, so its session is checked again on reconnect', async () => {
    const registry = t.app.get(StreamRegistry);
    registry.maxLifetimeMs = 400;
    try {
      const s = await connect('owner');
      await s.ended;
    } finally {
      registry.maxLifetimeMs = MAX_STREAM_LIFETIME_MS;
    }
    expect(MAX_STREAM_LIFETIME_MS).toBe(30 * 60_000);
  });

  it('binds the testkit publisher and queue to the testkit prefix (R138)', async () => {
    const testkit = t.app.select(TestkitModule);
    const events = testkit.get<EventPublisher>(EVENTS, { strict: true });
    const jobs = testkit.get<JobQueue>(JOBS, { strict: true });
    await expect(events.publish(ctl(), { type: 'other.x' })).rejects.toThrow(/testkit/);
    await expect(events.publish(ctl(), { type: 'core.x' })).rejects.toThrow(/testkit/);
    await expect(jobs.enqueue(ctl(), 'other.x', {})).rejects.toThrow(/testkit/);
    await expect(jobs.enqueue(ctl(), 'core.files-gc', {})).rejects.toThrow(/testkit/);
    await expect(events.publish(ctl(), { type: 'testkit.fine' })).resolves.toBeUndefined();
  });

  it('leaves no stream behind for a client that aborted during the guard, and frees its slot', async () => {
    const access = t.app.get(AccessService);
    const registry = t.app.get(StreamRegistry);
    const real = access.scopeFor.bind(access);
    let slow = true;
    const opened = vi.spyOn(registry, 'open');
    let inGuard = 0;
    let leftGuard = 0;
    const spy = vi.spyOn(access, 'scopeFor').mockImplementation(async (...args) => {
      const hold = args[0] === ids.aborter && slow;
      if (hold) inGuard++;
      const scope = await real(...args);
      if (hold) {
        await new Promise((r) => setTimeout(r, 300));
        leftGuard++;
      }
      return scope;
    });
    try {
      for (let i = 0; i < 5; i++) {
        const controller = new AbortController();
        const pending = fetch(`${base}/api/v1/workspaces/${ws}/events`, {
          headers: { cookie: cookies.aborter! },
          signal: controller.signal,
        }).catch(() => undefined);
        await vi.waitFor(() => expect(inGuard).toBe(i + 1));
        controller.abort();
        await pending;
      }
      await vi.waitFor(() => expect(leftGuard).toBe(5), { timeout: 4000 });
      // The server has finished with every aborted request: each reached the registry and was closed.
      await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(5));
      await vi.waitFor(() => expect(registry.count(ws, ids.aborter!)).toBe(0));
      slow = false;
      // One turn of the event loop, so the client's pool has dropped the aborted sockets.
      await new Promise((done) => setImmediate(done));
      const sixth = await connect('aborter');
      expect(sixth.status).toBe(200);
      expect(registry.count(ws, ids.aborter!)).toBe(1);
      sixth.abort();
    } finally {
      spy.mockRestore();
      opened.mockRestore();
    }
  });

  it('closes streams when a plain member creates a project, so the reconnect sees its events', async () => {
    const setting = await fetch(api('/settings'), {
      method: 'PATCH',
      ...json('owner', { membersCanCreateProjects: true }),
    });
    expect(setting.status).toBe(200);
    const before = await connect('creator');
    const made = await fetch(api('/projects'), {
      method: 'POST',
      ...json('creator', { name: 'Mine' }),
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    await before.ended;
    const after = await connect('creator');
    await t.app.get(EventsService).publish(ctl(), { type: 'testkit.mine', projectId: id });
    await after.next((f) => f.event === 'testkit.mine');
    after.abort();
  });

  it('refuses a stream with 503 events_unavailable while the listener is down', async () => {
    const listener = t.app.get(EventsListener);
    const pool = t.db.db.$client;
    await vi.waitFor(() => expect(listener.isUp()).toBe(true));
    // A wide first retry delay keeps the listener down long enough to be seen, however slow the machine.
    listener.backoffStartMs = 3000;
    try {
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'briefroom-events' AND datname = current_database()`,
      );
      let refused: Sse | undefined;
      await vi.waitFor(
        async () => {
          const s = await connect('owner');
          if (s.status === 200) s.abort();
          expect(s.status).toBe(503);
          refused = s;
        },
        { timeout: 2500, interval: 20 },
      );
      expect(refused!.body).toMatchObject({ code: 'events_unavailable' });
    } finally {
      listener.backoffStartMs = 500;
    }
    await vi.waitFor(() => expect(listener.isUp()).toBe(true), { timeout: 8000 });
  });

  it('refuses to publish a project of another workspace, even from an all-projects scope', async () => {
    const other = (
      await t.auth.api.createOrganization({
        body: { name: 'Elsewhere', slug: 'elsewhere', userId: ids.owner! },
      })
    ).id;
    const res = await fetch(`${base}/api/v1/workspaces/${other}/projects`, {
      method: 'POST',
      ...json('owner', { name: 'Foreign' }),
    });
    const { id } = (await res.json()) as { id: string };
    const events = t.app.get(EventsService);
    await expect(events.publish(ctl(), { type: 'testkit.x', projectId: id })).rejects.toThrow(
      /project/,
    );
    await expect(
      events.publish(ctl(), { type: 'testkit.x', projectId: 'not-a-uuid' }),
    ).rejects.toThrow(/project/);
  });

  it('revokes streams on sign-out only after the session is gone (R137)', async () => {
    const revocation = t.app.get(RevocationService);
    const real = revocation.sessionsRevoked.bind(revocation);
    let sessionWhenRevoked: unknown = 'unset';
    const spy = vi.spyOn(revocation, 'sessionsRevoked').mockImplementation(async (userId) => {
      if (userId === ids.signer2) {
        sessionWhenRevoked = await t.auth.api.getSession({
          headers: new Headers({ cookie: cookies.signer2! }),
        });
      }
      return real(userId);
    });
    try {
      const s = await connect('signer2');
      const out = await fetch(`${base}/api/auth/sign-out`, {
        method: 'POST',
        headers: { ...json('signer2').headers, origin: 'http://localhost:4300' },
        body: '{}',
      });
      expect(out.status).toBe(200);
      await s.ended;
      expect(sessionWhenRevoked).toBeNull();
      expect((await connect('signer2')).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes the client\u2019s socket after a server-side closeFor, and never reuses it for the next request', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const url = new URL(`${base}/api/v1/workspaces/${ws}/events`);
    const options = {
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      agent,
      headers: { cookie: cookies.owner! },
    };
    let closed = false;
    let connection: string | undefined;
    const first = http.get(options, (res) => {
      connection = res.headers.connection;
      res.resume();
      res.once('end', () => first.socket?.once('close', () => (closed = true)));
    });
    first.on('error', () => undefined);
    const registry = t.app.get(StreamRegistry);
    await vi.waitFor(() => expect(registry.count(ws, ids.owner!)).toBe(1));
    registry.closeFor(ws, ids.owner!);

    // Straight away, a second long-lived request on the same agent: it must not inherit the old
    // socket, or the delayed destroy below would kill it.
    const frames: string[] = [];
    const second = http.get(options, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => frames.push(chunk));
    });
    second.on('error', () => undefined);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000, interval: 50 });
    await new Promise((r) => setTimeout(r, 300));
    await t.app.get(EventsService).publish(ctl(), { type: 'testkit.after_close' });
    await vi.waitFor(() => expect(frames.join('')).toContain('testkit.after_close'), {
      timeout: 3000,
    });
    expect(connection).toBe('close');
    second.destroy();
    agent.destroy();
  });
});
