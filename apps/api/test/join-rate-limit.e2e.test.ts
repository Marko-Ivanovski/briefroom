import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.ts';

describe('join lookup rate limit', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('allows 20 lookups a minute per client and then returns 429 rate_limited', async () => {
    const get = () => request(t.app.getHttpServer()).get('/api/v1/join/whatever');
    for (let i = 0; i < 20; i++) expect((await get()).status).toBe(200);
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('allows 20 sign-up attempts a minute per client and then returns 429 rate_limited', async () => {
    const post = () =>
      request(t.app.getHttpServer())
        .post('/api/v1/join/whatever/sign-up')
        .send({ name: 'A', email: 'a@example.com', password: 'correct horse battery' });
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(410);
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('allows 20 accepts a minute per client and then returns 429 rate_limited', async () => {
    await t.auth.api.createUser({
      body: { email: 'acc@example.com', password: 'correct horse battery', name: 'Acc' },
    });
    const signedIn = await t.auth.api.signInEmail({
      body: { email: 'acc@example.com', password: 'correct horse battery' },
      asResponse: true,
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const post = () =>
      request(t.app.getHttpServer()).post('/api/v1/join/whatever/accept').set({ cookie });
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(410);
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('does not throttle other routes', async () => {
    const get = () => request(t.app.getHttpServer()).get('/api/v1/setup');
    for (let i = 0; i < 25; i++) expect((await get()).status).not.toBe(429);
  });
});
