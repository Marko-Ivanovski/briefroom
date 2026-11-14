import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemoteInvite, joinUrlOf, parseInviteUrl } from '../src/workspaces/remote-host.ts';

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return (err as { getResponse(): { code: string } }).getResponse().code;
  }
  return undefined;
};

describe('parseInviteUrl', () => {
  it('splits an invite URL into base and token, dropping query and fragment', () => {
    expect(parseInviteUrl('https://hub.example.com/join/abc123?x=1#frag')).toEqual({
      base: 'https://hub.example.com',
      token: 'abc123',
    });
  });

  it('keeps a path prefix and removes the trailing slash', () => {
    expect(parseInviteUrl('http://127.0.0.1:4300/briefroom/join/tok/')).toEqual({
      base: 'http://127.0.0.1:4300/briefroom',
      token: 'tok',
    });
  });

  it('rebuilds the join URL from the parsed parts', () => {
    expect(joinUrlOf(parseInviteUrl('http://h.test:81/p/join/tok?x=1'))).toBe(
      'http://h.test:81/p/join/tok',
    );
  });

  it.each([
    'ftp://h.test/join/abc',
    'file:///join/abc',
    'javascript:alert(1)',
    'https://user:pw@h.test/join/abc',
    'https://user@h.test/join/abc',
    'https://h.test/',
    'https://h.test/join/',
    'https://h.test/join/a/b',
    'https://h.test/other/abc',
    'not a url',
    '',
    `https://h.test/join/${'a'.repeat(2100)}`,
  ])('refuses %s with invalid_invite_url', (input) => {
    expect(codeOf(() => parseInviteUrl(input))).toBe('invalid_invite_url');
  });
});

describe('fetchRemoteInvite', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const failure = async (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (err: { getResponse(): { code: string; message: string }; getStatus(): number }) => ({
        status: err.getStatus(),
        ...err.getResponse(),
      }),
    );

  it('never answers: 502 host_unreachable within the 5 s budget', async () => {
    const base = await listen(() => undefined);
    const started = Date.now();
    const err = await failure(fetchRemoteInvite({ base, token: 't' }));
    expect(err).toMatchObject({ status: 502, code: 'host_unreachable' });
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  it('oversize body is refused as host_unreachable', async () => {
    const base = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url?.startsWith('/api/version')
          ? 'x'.repeat(70_000)
          : JSON.stringify({
              valid: true,
              workspaceId: 'w',
              workspaceName: 'W',
              role: 'member',
              requiresApproval: false,
            }),
      );
    });
    expect(await failure(fetchRemoteInvite({ base, token: 't' }))).toMatchObject({
      status: 502,
      code: 'host_unreachable',
    });
  });

  it('error messages never echo the remote body or the URL', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 500;
      res.end('SECRET-REMOTE-BODY');
    });
    const err = (await failure(fetchRemoteInvite({ base, token: 'tok-secret' }))) as {
      message: string;
    };
    expect(err.message).not.toMatch(/SECRET|127\.0\.0\.1|tok-secret|500/);
  });
});
