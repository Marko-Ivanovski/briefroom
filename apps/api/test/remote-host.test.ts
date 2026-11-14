import { randomBytes } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchRemoteInvite,
  isBlockedAddress,
  joinUrlOf,
  parseInviteUrl,
} from '../src/workspaces/remote-host.ts';

const TOKEN = 'tokenABCDEFGHIJKLMNOP';

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
    expect(parseInviteUrl(`https://hub.example.com/join/${TOKEN}?x=1#frag`)).toEqual({
      base: 'https://hub.example.com',
      token: TOKEN,
    });
  });

  it('keeps a path prefix and removes the trailing slash', () => {
    expect(parseInviteUrl(`http://127.0.0.1:4300/briefroom/join/${TOKEN}/`)).toEqual({
      base: 'http://127.0.0.1:4300/briefroom',
      token: TOKEN,
    });
  });

  it('accepts the real invite token format (32 random bytes, base64url)', () => {
    const real = randomBytes(32).toString('base64url');
    expect(parseInviteUrl(`https://h.test/join/${real}`).token).toBe(real);
  });

  it('rebuilds the join URL from the parsed parts', () => {
    expect(joinUrlOf(parseInviteUrl(`http://h.test:81/p/join/${TOKEN}?x=1`))).toBe(
      `http://h.test:81/p/join/${TOKEN}`,
    );
  });

  it.each([
    `ftp://h.test/join/${TOKEN}`,
    `file:///join/${TOKEN}`,
    'javascript:alert(1)',
    `https://user:pw@h.test/join/${TOKEN}`,
    `https://user@h.test/join/${TOKEN}`,
    'https://h.test/',
    'https://h.test/join/',
    `https://h.test/join/${TOKEN}/b`,
    `https://h.test/other/${TOKEN}`,
    'https://h.test/join/short',
    `https://h.test/join/${TOKEN}%20x`,
    `https://h.test/join/${'a'.repeat(129)}`,
    'not a url',
    '',
    `https://h.test/join/${'a'.repeat(2100)}`,
  ])('refuses %s with invalid_invite_url', (input) => {
    expect(codeOf(() => parseInviteUrl(input))).toBe('invalid_invite_url');
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.255',
    '255.255.255.255',
    'fe80::1',
    'febf::1',
    '::',
    'ff02::1',
    'fd00:ec2::254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:0.0.0.0',
    '::ffff:224.0.0.1',
    '::ffff:255.255.255.255',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.20',
    '93.184.216.34',
    '::1',
    'fd12:3456::1',
    'fc00::1',
    '2606:4700::1111',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
  ])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('fetchRemoteInvite', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const listen = async (handler: RequestListener): Promise<string> => {
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
  const json = (res: Parameters<RequestListener>[1], body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const VERSION = { api: '1', app: '0.0.0', installId: 'install-1' };
  const VALID = { valid: true, workspaceId: 'w1', workspaceName: 'W', role: 'member' };
  const host =
    (overrides: { version?: unknown; lookup?: unknown } = {}): RequestListener =>
    (req, res) =>
      json(
        res,
        req.url?.startsWith('/api/version')
          ? (overrides.version ?? VERSION)
          : (overrides.lookup ?? VALID),
      );
  const run = (base: string) => fetchRemoteInvite({ base, token: TOKEN });

  it('returns the install id and workspace for a valid invite', async () => {
    const base = await listen(host());
    expect(await run(base)).toEqual({
      installId: 'install-1',
      workspaceId: 'w1',
      workspaceName: 'W',
    });
  });

  it('never answers: 502 host_unreachable within the 5 s budget', async () => {
    const base = await listen(() => undefined);
    const started = Date.now();
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  it('a slow-drip body is aborted at the deadline with 502', async () => {
    const base = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.write('{');
      const timer = setInterval(() => res.write(' '), 300);
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
    expect(Date.now() - started).toBeLessThan(6500);
  }, 10_000);

  it('a redirect on the version call is 502', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/x');
      res.end();
    });
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it('a redirect on the lookup call is 502', async () => {
    const base = await listen((req, res) => {
      if (req.url?.startsWith('/api/version')) return json(res, VERSION);
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/x');
      res.end();
    });
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it('a host that answers 404 to everything is 502, not 400 (version goes first)', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it('a 404 lookup on a real install is 400 invite_invalid', async () => {
    const base = await listen((req, res) => {
      if (req.url?.startsWith('/api/version')) return json(res, VERSION);
      res.statusCode = 404;
      res.end();
    });
    expect(await failure(run(base))).toMatchObject({ status: 400, code: 'invite_invalid' });
  });

  it('{valid:false} on a real install is 400 invite_invalid', async () => {
    const base = await listen(host({ lookup: { valid: false } }));
    expect(await failure(run(base))).toMatchObject({ status: 400, code: 'invite_invalid' });
  });

  it('oversize body is refused as host_unreachable', async () => {
    const base = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url?.startsWith('/api/version') ? 'x'.repeat(70_000) : JSON.stringify(VALID));
    });
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it.each([
    ['a 60 KB workspaceId', { ...VALID, workspaceId: 'w'.repeat(60_000) }],
    ['an empty workspaceId', { ...VALID, workspaceId: '' }],
    ['a 65 character workspaceId', { ...VALID, workspaceId: 'w'.repeat(65) }],
    ['a 201 character workspaceName', { ...VALID, workspaceName: 'n'.repeat(201) }],
    ['a missing workspaceName', { valid: true, workspaceId: 'w1' }],
  ])('%s is 502, not 500', async (_name, lookup) => {
    const base = await listen(host({ lookup }));
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it.each([
    ['an empty installId', { ...VERSION, installId: '' }],
    ['a null installId', { ...VERSION, installId: null }],
    ['a 65 character installId', { ...VERSION, installId: 'i'.repeat(65) }],
    ['the wrong api version', { ...VERSION, api: '2' }],
  ])('%s is 502', async (_name, version) => {
    const base = await listen(host({ version }));
    expect(await failure(run(base))).toMatchObject({ status: 502, code: 'host_unreachable' });
  });

  it('refuses a link-local address without connecting', async () => {
    expect(await failure(run('http://169.254.169.254'))).toMatchObject({
      status: 502,
      code: 'host_unreachable',
    });
    expect(await failure(run('http://[::ffff:169.254.169.254]'))).toMatchObject({
      status: 502,
    });
  });

  it('error messages never echo the remote body or the URL', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 500;
      res.end('SECRET-REMOTE-BODY');
    });
    const err = (await failure(fetchRemoteInvite({ base, token: TOKEN }))) as { message: string };
    expect(err.message).not.toMatch(/SECRET|127\.0\.0\.1|tokenABC|500/);
  });

  describe('with an injected lookup', () => {
    type Lookup = NonNullable<Parameters<typeof fetchRemoteInvite>[1]>['lookup'];
    const fake = (answer: { address: string; family: number }[]) => {
      const calls: string[] = [];
      const lookup = (async (hostname: string) => {
        calls.push(hostname);
        return answer;
      }) as unknown as Lookup;
      return { calls, lookup };
    };
    const portOf = (base: string) => new URL(base).port;
    const recording = async () => {
      const hosts: (string | undefined)[] = [];
      let connections = 0;
      const base = await listen((req, res) => {
        hosts.push(req.headers.host);
        json(res, req.url?.startsWith('/api/version') ? VERSION : VALID);
      });
      server!.on('connection', () => connections++);
      return { base, hosts, connections: () => connections };
    };

    it('connects to the vetted address, keeps the hostname as Host, and resolves once', async () => {
      const seen = await recording();
      const { calls, lookup } = fake([{ address: '127.0.0.1', family: 4 }]);
      const base = `http://rebind.test:${portOf(seen.base)}`;
      await fetchRemoteInvite({ base, token: TOKEN }, { lookup });
      expect(seen.hosts).toEqual([
        `rebind.test:${portOf(seen.base)}`,
        `rebind.test:${portOf(seen.base)}`,
      ]);
      expect(calls).toEqual(['rebind.test']);
    });

    it('refuses the whole host when one of several addresses is blocked', async () => {
      const seen = await recording();
      const { lookup } = fake([
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
      const base = `http://mixed.test:${portOf(seen.base)}`;
      expect(await failure(fetchRemoteInvite({ base, token: TOKEN }, { lookup }))).toMatchObject({
        status: 502,
        code: 'host_unreachable',
      });
      expect(seen.connections()).toBe(0);
    });

    it('falls back to the next vetted address when the first does not answer', async () => {
      const seen = await recording();
      // Nothing listens on ::1 at this port (the server is bound to 127.0.0.1 only), so ::1 is refused or unavailable and the IPv4 entry has to carry the request.
      const { lookup } = fake([
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
      const base = `http://fallback.test:${portOf(seen.base)}`;
      expect(await fetchRemoteInvite({ base, token: TOKEN }, { lookup })).toMatchObject({
        installId: 'install-1',
      });
      expect(seen.hosts).toHaveLength(2);
    });
  });
});
