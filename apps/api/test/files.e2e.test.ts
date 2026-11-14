import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import nodeHttp from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files, projectMembers, scopedInsert } from '@briefroom/db';
import type { FileRecord } from '@briefroom/module-kit';
import { CORE_FILE_STORE, type CoreFileStore } from '@briefroom/module-kit/core';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FilesService } from '../src/files/files.service.ts';
import { ByteBudget } from '../src/files/byte-budget.ts';
import { Semaphore } from '../src/files/semaphore.ts';
import { WorkspaceModulesService } from '../src/module-registry/workspace-modules.service.ts';
import { pngClaiming } from './image-fixtures.ts';
import { createTestApp, makeInstallOwner, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const MB = 1024 * 1024;

const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .png()
    .toBuffer();

const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('file store', () => {
  let t: TestApp;
  let dataDir: string;
  let ws: string;
  let otherWs: string;
  let projectId: string;
  let big: Buffer;
  let small: Buffer;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const base = (w = ws) => `/api/v1/workspaces/${w}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const upload = (
    who: string,
    bytes: Buffer,
    query = '',
    contentType = 'application/octet-stream',
  ) =>
    http()
      .post(`${base()}/m/testkit/files${query}`)
      .set(as(who))
      .set('Content-Type', contentType)
      .send(bytes);
  /**
   * Streams the body over a real socket and reports the status as soon as the response arrives.
   * A server that answers without reading a large body may reset the connection afterwards, which
   * is fine here, so errors after the response are ignored.
   */
  const rawUpload = async (who: string, body: Readable, query: string, withLength: boolean) => {
    const server = t.app.getHttpServer();
    if (!server.listening) await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    return new Promise<{ status: number }>((resolve, reject) => {
      const req = nodeHttp.request(
        {
          port,
          host: '127.0.0.1',
          method: 'POST',
          path: `${base()}/m/testkit/files${query}`,
          headers: {
            cookie: cookies[who]!,
            'content-type': 'application/octet-stream',
            ...(withLength ? { 'content-length': String(21 * MB) } : {}),
          },
        },
        (res) => {
          resolve({ status: res.statusCode ?? 0 });
          res.resume();
        },
      );
      req.on('error', (err) => reject(err));
      body.on('error', () => undefined);
      body.pipe(req);
    });
  };
  /** Starts an upload that sends a few bytes of a 1 MB body and then goes quiet. */
  const stalledUpload = async (who: string, trickle = false) => {
    const server = t.app.getHttpServer();
    if (!server.listening) await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    const agent = new nodeHttp.Agent({ keepAlive: true });
    let socketClosed!: () => void;
    const closed = new Promise<void>((done) => {
      socketClosed = done;
    });
    let settle!: (r: { status: number; body: Record<string, unknown> }) => void;
    const response = new Promise<{ status: number; body: Record<string, unknown> }>((done) => {
      settle = done;
    });
    const req = nodeHttp.request(
      {
        port,
        host: '127.0.0.1',
        method: 'POST',
        agent,
        path: `${base()}/m/testkit/files`,
        headers: {
          cookie: cookies[who]!,
          'content-type': 'application/octet-stream',
          'content-length': String(MB),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () =>
          settle({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(parts).toString() || '{}'),
          }),
        );
      },
    );
    req.on('error', () => undefined);
    req.on('socket', (socket) => socket.once('close', socketClosed));
    req.write(Buffer.alloc(1024, 1));
    if (trickle) {
      const timer = setInterval(() => req.write(Buffer.alloc(1, 1)), 50);
      closed.then(() => clearInterval(timer));
    }
    await new Promise((done) => setTimeout(done, 300));
    return { req, response, closed };
  };
  const dirCount = async () => (await readdir(join(dataDir, 'files', ws)).catch(() => [])).length;
  const get = (who: string, id: string, size?: string, w = ws) =>
    http()
      .get(`${base(w)}/files/${id}${size ? `?size=${size}` : ''}`)
      .set(as(who))
      .buffer(true)
      .parse(binary);
  const stored = async (bytes: Buffer, who = 'writer', query = '') => {
    const res = await upload(who, bytes, query);
    expect(res.status).toBe(201);
    return res.body as FileRecord;
  };
  const setModule = (enabled: boolean) =>
    t.app
      .get(WorkspaceModulesService)
      .update({ workspaceId: ws, actor: { userId: ids.owner!, via: 'web' } } as never, 'testkit', {
        enabled,
      });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'briefroom-files-'));
    t = await createTestApp({ BRIEFROOM_DATA_DIR: dataDir });
    [big, small] = await Promise.all([image(3000, 2000), image(300, 200)]);
    for (const key of ['owner', 'writer', 'onproject', 'noproject', 'reader', 'outsider']) {
      const { user } = await t.auth.api.createUser({
        body: { email: `${key}@example.com`, password: PASSWORD, name: key },
      });
      ids[key] = user.id;
      const res = await t.auth.api.signInEmail({
        body: { email: `${key}@example.com`, password: PASSWORD },
        asResponse: true,
      });
      cookies[key] = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    }
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    otherWs = (
      await t.auth.api.createOrganization({
        body: { name: 'Other', slug: 'other', userId: ids.owner! },
      })
    ).id;
    for (const key of ['writer', 'onproject', 'noproject', 'reader']) {
      await t.auth.api.addMember({
        body: { userId: ids[key]!, role: 'member', organizationId: ws },
      });
    }
    const actor = { userId: ids.owner!, via: 'web' } as const;
    for (const w of [ws, otherWs]) {
      await t.app.get(WorkspaceModulesService).enableStarting(w, actor, ['testkit']);
    }
    await http()
      .put(`${base()}/members/${ids.writer}/permissions`)
      .set(as('owner'))
      .send({ moduleId: 'testkit', key: 'write-notes', granted: true });
    projectId = (await http().post(`${base()}/projects`).set(as('owner')).send({ name: 'P' })).body
      .id;
    for (const key of ['writer', 'onproject']) {
      await t.db.db
        .insert(projectMembers)
        .values(scopedInsert({ workspaceId: ws, actor }, { projectId, userId: ids[key]! }));
    }
  });

  afterAll(async () => {
    await t.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores the original byte for byte with a 480 wide thumb and a 1600 wide reduced copy', async () => {
    const record = await stored(big);
    expect(record).toMatchObject({
      workspaceId: ws,
      projectId: null,
      moduleId: 'testkit',
      mime: 'image/png',
      bytes: big.length,
      sha256: createHash('sha256').update(big).digest('hex'),
      width: 3000,
      height: 2000,
    });

    const dir = join(dataDir, 'files', ws, record.id);
    expect((await readdir(dir)).sort()).toEqual(['original.png', 'reduced.webp', 'thumb.webp']);
    expect((await readFile(join(dir, 'original.png'))).equals(big)).toBe(true);

    const thumb = await get('writer', record.id, 'thumb');
    const reduced = await get('writer', record.id, 'reduced');
    const original = await get('writer', record.id, 'original');
    expect((await sharp(thumb.body).metadata()).width).toBe(480);
    expect((await sharp(reduced.body).metadata()).width).toBe(1600);
    expect(original.body.equals(big)).toBe(true);
    expect(original.headers['content-type']).toBe('image/png');
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(reduced.headers['content-type']).toBe('image/webp');
  });

  it('keeps EXIF in the original and strips it from the served copies (R117)', async () => {
    const jpeg = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret owner' } })
      .toBuffer();
    const record = await stored(jpeg);
    expect(record.mime).toBe('image/jpeg');
    const original = await get('writer', record.id, 'original');
    expect(original.body.equals(jpeg)).toBe(true);
    expect((await sharp(original.body).metadata()).exif).toBeDefined();
    for (const size of ['thumb', 'reduced']) {
      const res = await get('writer', record.id, size);
      expect(res.status).toBe(200);
      expect((await sharp(res.body).metadata()).exif).toBeUndefined();
      expect(res.body.includes(Buffer.from('secret'))).toBe(false);
    }
  });

  it('answers with the safe headers on every size', async () => {
    const record = await stored(small);
    for (const size of ['thumb', 'reduced', 'original']) {
      const res = await get('writer', record.id, size);
      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.headers['content-disposition']).toMatch(/^inline/);
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it(
    'stores directories as 0700 and files as 0600',
    { skip: process.platform === 'win32' },
    async () => {
      const record = await stored(small);
      const dir = join(dataDir, 'files', ws, record.id);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(dir)) {
        expect((await stat(join(dir, name))).mode & 0o777, name).toBe(0o600);
      }
    },
  );

  it('refuses a chunked upload over the limit that declares no length', async () => {
    const chunks = Array.from({ length: 21 }, () => Buffer.alloc(MB, 1));
    const res = await rawUpload('writer', Readable.from(chunks), '', false);
    expect(res.status).toBe(413);
  });

  describe('slow clients (R128)', () => {
    it('does not let a stalled upload hold an image slot', async () => {
      const service = t.app.get(FilesService);
      const { jobs, readLimits } = service;
      service.jobs = new Semaphore(1, 0);
      service.readLimits = { idleMs: 5000, totalMs: 10_000 };
      const stalled = await stalledUpload('writer');
      try {
        const res = await upload('writer', small);
        expect(res.status).toBe(201);
      } finally {
        stalled.req.destroy();
        service.jobs = jobs;
        service.readLimits = readLimits;
      }
    });

    it('answers 408 upload_timeout when a client sends nothing for too long', async () => {
      const service = t.app.get(FilesService);
      const { readLimits } = service;
      service.readLimits = { idleMs: 300, totalMs: 10_000 };
      try {
        const stalled = await stalledUpload('writer');
        const res = await stalled.response;
        expect(res.status).toBe(408);
        expect(res.body).toMatchObject({ code: 'upload_timeout' });
      } finally {
        service.readLimits = readLimits;
      }
    });

    it('closes the socket promptly after a 408, even if the client keeps sending', async () => {
      const service = t.app.get(FilesService);
      const { readLimits } = service;
      service.readLimits = { idleMs: 5000, totalMs: 300 };
      try {
        const stalled = await stalledUpload('writer', true);
        expect((await stalled.response).status).toBe(408);
        const outcome = await Promise.race([
          stalled.closed.then(() => 'closed'),
          new Promise((done) => setTimeout(() => done('open'), 2000)),
        ]);
        expect(outcome).toBe('closed');
      } finally {
        service.readLimits = readLimits;
      }
    });

    it('configures the server timeouts (R130)', () => {
      const server = t.app.getHttpServer();
      expect(server.requestTimeout).toBe(120_000);
      expect(server.headersTimeout).toBe(30_000);
    });

    it('refuses with 503 before reading when the byte budget is spent, and recovers (R129)', async () => {
      const service = t.app.get(FilesService);
      const { budget } = service;
      const spent = new ByteBudget(2 * MB + 512 * 1024);
      service.budget = spent;
      const reserved = async (bytes: number) => {
        const deadline = Date.now() + 2000;
        while (spent.used !== bytes) {
          if (Date.now() > deadline) {
            throw new Error(`budget never reached ${bytes} bytes reserved, stuck at ${spent.used}`);
          }
          await new Promise((done) => setTimeout(done, 10));
        }
      };
      try {
        const first = await stalledUpload('writer');
        const second = await stalledUpload('writer');
        await reserved(2 * MB);
        const third = await stalledUpload('writer');
        const res = await third.response;
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ code: 'busy' });
        first.req.destroy();
        second.req.destroy();
        third.req.destroy();
        await new Promise((done) => setTimeout(done, 300));
        expect((await upload('writer', small)).status).toBe(201);
      } finally {
        service.budget = budget;
      }
    });

    it('releases the reader permit after a timeout', async () => {
      const service = t.app.get(FilesService);
      const { readers, readLimits } = service;
      service.readers = new Semaphore(1, 0);
      service.readLimits = { idleMs: 200, totalMs: 10_000 };
      try {
        expect((await (await stalledUpload('writer')).response).status).toBe(408);
        expect((await upload('writer', small)).status).toBe(201);
      } finally {
        service.readers = readers;
        service.readLimits = readLimits;
      }
    });

    it('answers 503 busy when every reader is taken and the queue is full', async () => {
      const service = t.app.get(FilesService);
      const { readers } = service;
      service.readers = new Semaphore(0, 0);
      try {
        const res = await upload('writer', small);
        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
      } finally {
        service.readers = readers;
      }
    });

    it('survives a client that drops mid-body: no 500, nothing on disk, permit released', async () => {
      const service = t.app.get(FilesService);
      const { readers } = service;
      service.readers = new Semaphore(1, 0);
      const errors = vi.spyOn(Logger.prototype, 'error');
      const before = await dirCount();
      try {
        const stalled = await stalledUpload('writer');
        stalled.req.destroy();
        await new Promise((done) => setTimeout(done, 300));
        expect(errors).not.toHaveBeenCalled();
        expect(await dirCount()).toBe(before);
        expect((await upload('writer', small)).status).toBe(201);
      } finally {
        errors.mockRestore();
        service.readers = readers;
      }
    });
  });

  it('answers 503 busy with Retry-After when the image queue is full', async () => {
    const service = t.app.get(FilesService);
    const original = service.jobs;
    service.jobs = new Semaphore(0, 0);
    try {
      const res = await upload('writer', small);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'busy' });
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      service.jobs = original;
    }
  });

  it('does not read the body of a caller without the permission', async () => {
    const res = await rawUpload('reader', Readable.from([Buffer.alloc(21 * MB, 1)]), '', true);
    expect(res.status).toBe(403);
  });

  it('does not read the body when the project is not visible', async () => {
    const hidden = (await http().post(`${base()}/projects`).set(as('owner')).send({ name: 'H2' }))
      .body.id as string;
    const body = Readable.from([Buffer.alloc(21 * MB, 1)]);
    const res = await rawUpload('writer', body, `?projectId=${hidden}`, true);
    expect(res.status).toBe(404);
  });

  it('serves the original when no size is given and refuses an unknown size', async () => {
    const record = await stored(small);
    expect((await get('writer', record.id)).body.equals(small)).toBe(true);
    expect((await get('writer', record.id, 'huge')).status).toBe(400);
  });

  it('decides the type from the bytes, not the header', async () => {
    const asText = await upload('writer', small, '', 'text/plain');
    expect(asText.status).toBe(201);
    expect(asText.body.mime).toBe('image/png');

    const fake = await upload('writer', Buffer.from('plain text, not a picture'), '', 'image/png');
    expect(fake.status).toBe(415);
    expect(fake.body.message).toBe('Only PNG, JPEG and WebP images are accepted');
  });

  it('refuses a gif, an svg and an empty body with 415', async () => {
    const gif = await sharp({ create: { width: 9, height: 9, channels: 3, background: '#000' } })
      .gif()
      .toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>');
    for (const bytes of [gif, svg, Buffer.alloc(0)]) {
      expect((await upload('writer', bytes, '', 'image/png')).status).toBe(415);
    }
  });

  it('refuses a decompression bomb with 413 and a fixed message', async () => {
    const bomb = pngClaiming(30_000, 30_000);
    const res = await upload('writer', bomb);
    expect(res.status).toBe(413);
    expect(res.body.message).toBe('The image has too many pixels');
  });

  it('refuses 21 MB with 413', async () => {
    const res = await upload('writer', Buffer.alloc(21 * MB, 1));
    expect(res.status).toBe(413);
  });

  it('keeps the JSON-only rule on every other route', async () => {
    const res = await http()
      .post(`${base()}/m/testkit/notes`)
      .set(as('writer'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(200 * 1024, 1));
    expect(res.status).toBe(400);
  });

  it('applies the Origin check to the upload route', async () => {
    const res = await http()
      .post(`${base()}/m/testkit/files`)
      .set(as('writer'))
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/octet-stream')
      .send(small);
    expect(res.status).toBe(403);
  });

  it('needs the module permission and a session to upload', async () => {
    expect((await upload('reader', small)).status).toBe(403);
    expect(
      (
        await http()
          .post(`${base()}/m/testkit/files`)
          .set('Content-Type', 'application/octet-stream')
          .send(small)
      ).status,
    ).toBe(401);
  });

  it('shows a project file only to people who can see the project', async () => {
    const record = await stored(small, 'writer', `?projectId=${projectId}`);
    expect(record.projectId).toBe(projectId);
    for (const who of ['writer', 'onproject', 'owner']) {
      expect((await get(who, record.id, 'thumb')).status, who).toBe(200);
    }
    expect((await get('noproject', record.id, 'thumb')).status).toBe(404);
    expect((await get('noproject', record.id, 'original')).status).toBe(404);
    expect((await get('outsider', record.id, 'thumb')).status).toBe(404);
  });

  it('shows a workspace-level file to a member on no project', async () => {
    const record = await stored(small);
    expect(record.projectId).toBeNull();
    expect((await get('noproject', record.id, 'thumb')).status).toBe(200);
    expect((await get('reader', record.id, 'original')).status).toBe(200);
  });

  it('refuses a project the uploader cannot see, and a malformed project id', async () => {
    const hidden = (
      await http().post(`${base()}/projects`).set(as('owner')).send({ name: 'Hidden' })
    ).body.id as string;
    expect((await upload('writer', small, `?projectId=${hidden}`)).status).toBe(404);
    expect((await upload('writer', small, '?projectId=not-a-uuid')).status).toBe(400);
  });

  it('does not serve a file through another workspace', async () => {
    const record = await stored(small);
    expect((await get('owner', record.id, 'original', otherWs)).status).toBe(404);
  });

  it('answers 404 to a path traversal in the file id', async () => {
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '..%2F', '%2e%2e%2f', 'not-a-uuid']) {
      const res = await http().get(`${base()}/files/${id}?size=original`).set(as('owner'));
      expect(res.status, id).toBe(404);
    }
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await get('owner', unknown)).status).toBe(404);
  });

  it('requires a session to read', async () => {
    const record = await stored(small);
    expect((await http().get(`${base()}/files/${record.id}`)).status).toBe(401);
  });

  describe('modules (R116)', () => {
    it('refuses an unregistered module with 400 and a switched-off module with 409', async () => {
      const store = t.app.get<CoreFileStore>(CORE_FILE_STORE);
      const scope = {
        userId: ids.owner!,
        workspaceId: ws,
        role: 'owner',
        visibleProjectIds: 'all',
        permissions: new Set<string>(),
        actor: { userId: ids.owner!, via: 'web' },
      } as const;
      const before = await t.db.db.select().from(files);

      await expect(store.store(scope, { moduleId: 'nope', bytes: small })).rejects.toMatchObject({
        status: 400,
      });
      await setModule(false);
      await expect(store.store(scope, { moduleId: 'testkit', bytes: small })).rejects.toMatchObject(
        {
          status: 409,
          response: { code: 'module_off' },
        },
      );
      await setModule(true);
      expect(await t.db.db.select().from(files)).toHaveLength(before.length);
    });

    it('answers 409 module_off on a read while the module is off, and serves it again after', async () => {
      const record = await stored(small);
      await setModule(false);
      try {
        const off = await http().get(`${base()}/files/${record.id}`).set(as('writer'));
        expect(off.status).toBe(409);
        expect(off.body).toMatchObject({ code: 'module_off', moduleId: 'testkit' });
        const upload409 = await upload('writer', small);
        expect(upload409.status).toBe(409);
      } finally {
        await setModule(true);
      }
      expect((await get('writer', record.id)).status).toBe(200);
    });
  });

  describe('removing files (R142)', () => {
    const remove = (who: string, id: string) =>
      http().delete(`${base()}/m/testkit/files/${id}`).set(as(who));

    it('removes the row and the directory, and the file then reads 404', async () => {
      const record = await stored(small);
      const dir = join(dataDir, 'files', ws, record.id);
      expect(existsSync(dir)).toBe(true);
      expect((await remove('writer', record.id)).status).toBe(204);
      expect(await t.db.db.select().from(files).where(eq(files.id, record.id))).toHaveLength(0);
      expect(existsSync(dir)).toBe(false);
      expect((await get('writer', record.id)).status).toBe(404);
      expect((await remove('writer', record.id)).status).toBe(404);
    });

    it('needs the module permission and treats a malformed id as missing', async () => {
      const record = await stored(small);
      expect((await remove('reader', record.id)).status).toBe(403);
      expect((await remove('writer', 'not-a-uuid')).status).toBe(404);
      expect((await get('writer', record.id)).status).toBe(200);
    });

    it("cannot remove another module's file: 404, and the file stays", async () => {
      const [row] = await t.db.db
        .insert(files)
        .values(
          scopedInsert(
            { workspaceId: ws, actor: { userId: ids.owner!, via: 'web' } },
            {
              projectId: null,
              moduleId: 'design',
              mime: 'image/png',
              bytes: 1,
              sha256: 'x',
              width: 1,
              height: 1,
            },
          ),
        )
        .returning();
      try {
        expect((await remove('writer', row!.id)).status).toBe(404);
        expect(await t.db.db.select().from(files).where(eq(files.id, row!.id))).toHaveLength(1);
      } finally {
        await t.db.db.delete(files).where(eq(files.id, row!.id));
      }
    });

    it('answers 404 for a file on a project the caller cannot see, and keeps it', async () => {
      await http()
        .put(`${base()}/members/${ids.noproject}/permissions`)
        .set(as('owner'))
        .send({ moduleId: 'testkit', key: 'write-notes', granted: true })
        .expect(200);
      const record = await stored(small, 'writer', `?projectId=${projectId}`);
      expect((await remove('noproject', record.id)).status).toBe(404);
      expect((await get('writer', record.id)).status).toBe(200);
      expect((await remove('onproject', record.id)).status).toBe(403);
      expect((await remove('writer', record.id)).status).toBe(204);
    });

    it('still removes the row when the directory is already gone', async () => {
      const record = await stored(small);
      await rm(join(dataDir, 'files', ws, record.id), { recursive: true });
      expect((await remove('writer', record.id)).status).toBe(204);
      expect(await t.db.db.select().from(files).where(eq(files.id, record.id))).toHaveLength(0);
    });
  });

  it('writes the audit columns and keeps nothing on disk for a rejected upload', async () => {
    const record = await stored(small);
    const [row] = await t.db.db.select().from(files).where(eq(files.id, record.id));
    expect(row).toMatchObject({
      createdBy: ids.writer,
      updatedBy: ids.writer,
      createdVia: 'web',
      updatedVia: 'web',
    });
    const dirs = await readdir(join(dataDir, 'files', ws));
    const rows = await t.db.db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.workspaceId, ws));
    expect(dirs.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(existsSync(join(dataDir, 'files', ws, record.id, 'thumb.webp'))).toBe(true);
  });
});
