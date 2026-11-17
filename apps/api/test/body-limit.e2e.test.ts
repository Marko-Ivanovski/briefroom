import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.ts';

const MB = 1024 * 1024;

describe('JSON body size limit', () => {
  let t: TestApp;
  let port: number;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    port = (t.app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await t.close();
  });

  const body = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes) });

  /** Sends the pieces with `Transfer-Encoding: chunked` and no Content-Length. */
  function chunked(path: string, pieces: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      for (const piece of pieces) req.write(piece);
      req.end();
    });
  }

  it.each(['/api/v1/workspaces', '/api/auth/sign-in/email'])(
    'answers 413 to a Content-Length over 1 MB on %s',
    async (path) => {
      const res = await request(t.app.getHttpServer())
        .post(path)
        .set('content-type', 'application/json')
        .send(body(MB + 1));
      expect(res.status).toBe(413);
    },
  );

  it('accepts a body of 900 KB on a normal route, which only holds with the 1 MB parser limit', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/v1/workspaces')
      .set('content-type', 'application/json')
      .send(body(900 * 1024));
    expect(res.status).not.toBe(413);
  });

  it('lets an /api/auth POST with Content-Length: 0 through to Better Auth', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('content-type', 'application/json')
      .set('content-length', '0');
    expect(res.status).toBeLessThan(500);
    expect([411, 413]).not.toContain(res.status);
  });

  it('answers 413 to a chunked /api/auth body over the limit', async () => {
    const piece = 'x'.repeat(256 * 1024);
    const res = await chunked('/api/auth/sign-in/email', [
      '{"pad":"',
      ...Array(5).fill(piece),
      '"}',
    ]);
    expect(res.status).toBe(413);
  });

  it('passes a chunked /api/auth body under the limit to Better Auth', async () => {
    const res = await chunked('/api/auth/sign-in/email', [
      '{"email":"nobody@example.com",',
      '"password":"wrong-password"}',
    ]);
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/INVALID_EMAIL_OR_PASSWORD/);
  });

  it('does not refuse a chunked JSON POST on another route for being chunked', async () => {
    const res = await chunked('/api/v1/workspaces', ['{"name":', '"x"}']);
    expect([411, 413]).not.toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });
});
