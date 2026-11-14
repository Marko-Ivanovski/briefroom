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

  it('does not throttle other routes', async () => {
    const get = () => request(t.app.getHttpServer()).get('/api/v1/setup');
    for (let i = 0; i < 25; i++) expect((await get()).status).not.toBe(429);
  });
});
