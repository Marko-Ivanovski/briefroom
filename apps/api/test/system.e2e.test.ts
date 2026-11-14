import { VersionResponse } from '@briefroom/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.ts';

describe('system routes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/version matches the VersionResponse contract', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/version');
    expect(res.status).toBe(200);
    const body = VersionResponse.parse(res.body);
    expect(body.api).toBe('1');
    expect(body.installId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves index.html for a client route', async () => {
    const res = await request(t.app.getHttpServer()).get('/some/client/route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Briefroom test fixture');
  });

  it('returns a 404 JSON body for an unknown api route', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it.each(['/api', '/mcp'])('does not fall back to index.html for bare %s', async (path) => {
    const res = await request(t.app.getHttpServer()).get(path);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not fall back to index.html under /.well-known', async () => {
    const res = await request(t.app.getHttpServer()).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it.each(['/api/health', '/api/nope', '/api/auth/ok', '/', '/some/client/route'])(
    'sends Referrer-Policy: no-referrer on %s',
    async (path) => {
      const res = await request(t.app.getHttpServer()).get(path);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    },
  );

  it('does not fall back to index.html under /mcp', async () => {
    const res = await request(t.app.getHttpServer()).get('/mcp/anything');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
