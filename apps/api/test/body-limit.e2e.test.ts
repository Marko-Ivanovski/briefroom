import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.ts';

describe('JSON body size limit', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  const body = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes) });

  it.each(['/api/v1/workspaces', '/api/auth/sign-in/email'])(
    'answers 413 to a body over 1 MB on %s',
    async (path) => {
      const res = await request(t.app.getHttpServer())
        .post(path)
        .set('content-type', 'application/json')
        .send(body(1024 * 1024 + 1));
      expect(res.status).toBe(413);
    },
  );

  it('accepts a body just under the limit', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/v1/workspaces')
      .set('content-type', 'application/json')
      .send(body(900 * 1024));
    expect(res.status).not.toBe(413);
  });
});
