import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { run } from '../src/cli.ts';
import { ENV_KEYS, parseEnv } from '../src/env-file.ts';
import { testContext, type TestContext } from './helpers.ts';

const RELEASE = `https://github.com/marko-ivanovski/briefroom/releases/download/v${pkg.version}`;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const SECRETS = ['BETTER_AUTH_SECRET', 'BRIEFROOM_SECRET_KEY', 'POSTGRES_PASSWORD'];

function fakeFetch(requested: string[], failOn?: string): typeof fetch {
  return ((url: string) => {
    requested.push(String(url));
    if (failOn && String(url).endsWith(failOn)) {
      return Promise.resolve(new Response('missing', { status: 404 }));
    }
    return Promise.resolve(new Response(`content of ${String(url).split('/').pop()}`));
  }) as typeof fetch;
}

const lanInterfaces = (() => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.20', family: 'IPv4', internal: false },
  ],
})) as never;

describe('init', () => {
  let t: TestContext | undefined;
  afterEach(() => t?.cleanup());

  async function setup(failOn?: string) {
    const requested: string[] = [];
    t = await testContext({
      fetch: fakeFetch(requested, failOn),
      networkInterfaces: lanInterfaces,
    });
    return { requested, dir: join(t.home, 'install') };
  }
  const readEnv = async (dir: string) => parseEnv(await readFile(join(dir, '.env'), 'utf8'));

  it('writes every .env.example variable with 43 character secrets', async () => {
    const { dir } = await setup();
    expect(await run(['init', dir, '--yes'], t!.ctx)).toBe(0);
    const env = await readEnv(dir);
    const example = (await readFile(join(import.meta.dirname, '../../../.env.example'), 'utf8'))
      .split('\n')
      .flatMap((l) => /^([A-Z_]+)=/.exec(l)?.[1] ?? []);
    expect(ENV_KEYS).toEqual(example);
    for (const key of example) expect(env).toHaveProperty(key);
    for (const key of SECRETS) expect(env[key]).toMatch(BASE64URL_43);
    expect(new Set(SECRETS.map((k) => env[k])).size).toBe(3);
    expect(env).toMatchObject({
      BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
      BRIEFROOM_BIND: '127.0.0.1',
      PORT: '4300',
      BRIEFROOM_VERSION: pkg.version,
      COMPOSE_PROFILES: '',
      BRIEFROOM_TESTKIT: '',
      BRIEFROOM_TRUSTED_PROXIES: '',
    });
  });

  it('writes .env with mode 600', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes'], t!.ctx);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
    }
  });

  it('downloads compose.yml and Caddyfile for the cli version and prints the next step', async () => {
    const { dir, requested } = await setup();
    await run(['init', dir, '--yes', '--port', '4400'], t!.ctx);
    expect(requested).toEqual([`${RELEASE}/compose.yml`, `${RELEASE}/Caddyfile`]);
    expect(await readFile(join(dir, 'compose.yml'), 'utf8')).toBe('content of compose.yml');
    expect(await readFile(join(dir, 'Caddyfile'), 'utf8')).toBe('content of Caddyfile');
    const out = t!.stdout.join('');
    expect(out).toContain('docker compose up -d');
    expect(out).toContain('http://localhost:4400');
    expect((await readEnv(dir)).BRIEFROOM_PUBLIC_URL).toBe('http://localhost:4400');
  });

  it('names the url when a download fails', async () => {
    const { dir } = await setup('Caddyfile');
    expect(await run(['init', dir, '--yes'], t!.ctx)).toBe(1);
    expect(t!.stderr.join('')).toContain(`${RELEASE}/Caddyfile`);
  });

  it('keeps the secrets and unknown keys on a second run', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes'], t!.ctx);
    const first = await readEnv(dir);
    const text = await readFile(join(dir, '.env'), 'utf8');
    await writeFile(join(dir, '.env'), `${text}MY_EXTRA=keep me\n`);
    await run(['init', dir, '--yes'], t!.ctx);
    const second = await readEnv(dir);
    for (const key of SECRETS) expect(second[key]).toBe(first[key]);
    expect(second.MY_EXTRA).toBe('keep me');
  });

  it('changes only what was asked on a second run', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes', '--port', '4500'], t!.ctx);
    await run(['init', dir, '--yes'], t!.ctx);
    expect((await readEnv(dir)).PORT).toBe('4500');
    await run(['init', dir, '--yes', '--port', '4600'], t!.ctx);
    expect((await readEnv(dir)).BRIEFROOM_PUBLIC_URL).toBe('http://localhost:4600');
  });

  it('--lan keeps the app port on loopback, turns on the lan profile and uses the first LAN address', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes', '--lan'], t!.ctx);
    expect(await readEnv(dir)).toMatchObject({
      BRIEFROOM_BIND: '127.0.0.1',
      COMPOSE_PROFILES: 'lan',
      BRIEFROOM_HOST: '192.168.1.20',
      BRIEFROOM_HTTPS_PORT: '443',
      BRIEFROOM_PUBLIC_URL: 'https://192.168.1.20',
    });
  });

  it('--host overrides the address and a custom https port is part of the url', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes', '--lan', '--host', 'brief.home'], t!.ctx);
    const text = await readFile(join(dir, '.env'), 'utf8');
    await writeFile(
      join(dir, '.env'),
      text.replace('BRIEFROOM_HTTPS_PORT=443', 'BRIEFROOM_HTTPS_PORT=8443'),
    );
    await run(['init', dir, '--yes'], t!.ctx);
    expect(await readEnv(dir)).toMatchObject({
      BRIEFROOM_HOST: 'brief.home',
      BRIEFROOM_PUBLIC_URL: 'https://brief.home:8443',
      COMPOSE_PROFILES: 'lan',
    });
  });

  it('--local after --lan turns the profile and host back off', async () => {
    const { dir } = await setup();
    await run(['init', dir, '--yes', '--lan'], t!.ctx);
    await run(['init', dir, '--yes', '--local'], t!.ctx);
    expect(await readEnv(dir)).toMatchObject({
      BRIEFROOM_BIND: '127.0.0.1',
      COMPOSE_PROFILES: '',
      BRIEFROOM_HOST: '',
      BRIEFROOM_PUBLIC_URL: 'http://localhost:4300',
    });
  });

  it('asks the questions with defaults when interactive', async () => {
    const asked: string[] = [];
    const answers: string[] = [];
    t = await testContext({
      fetch: fakeFetch([]),
      interactive: true,
      networkInterfaces: lanInterfaces,
      ask: (prompt) => {
        asked.push(prompt);
        return Promise.resolve(answers.shift() ?? '');
      },
    });
    const dir = join(t.home, 'asked');
    answers.push(dir, '4700', '2', '');
    expect(await run(['init'], t.ctx)).toBe(0);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain('./briefroom');
    expect(asked[1]).toContain('4300');
    expect(asked[2]).toContain('Local network');
    expect(asked[3]).toContain('192.168.1.20');
    expect(await readEnv(dir)).toMatchObject({ PORT: '4700', COMPOSE_PROFILES: 'lan' });
  });

  it('rejects a bad port and a host that could inject env lines', async () => {
    const { dir } = await setup();
    expect(await run(['init', dir, '--yes', '--port', '99999'], t!.ctx)).toBe(1);
    expect(await run(['init', dir, '--yes', '--lan', '--host', 'a\nEVIL=1'], t!.ctx)).toBe(1);
  });

  it('refuses to write .env through a symbolic link', async () => {
    const { dir } = await setup();
    await mkdir(dir, { recursive: true });
    await writeFile(join(t!.home, 'target'), 'x');
    try {
      await symlink(join(t!.home, 'target'), join(dir, '.env'));
    } catch {
      return;
    }
    expect(await run(['init', dir, '--yes'], t!.ctx)).toBe(1);
    expect(await readFile(join(t!.home, 'target'), 'utf8')).toBe('x');
  });

  describe('inside an existing install', () => {
    it('reuses the folder and keeps its secrets when no folder is given', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes'], t!.ctx);
      const first = await readEnv(dir);
      t!.ctx.cwd = dir;
      expect(await run(['init', '--yes', '--port', '4800'], t!.ctx)).toBe(0);
      const second = await readEnv(dir);
      for (const key of SECRETS) expect(second[key]).toBe(first[key]);
      expect(second.PORT).toBe('4800');
      await expect(stat(join(dir, 'briefroom'))).rejects.toThrow();
    });

    it('offers . as the default folder when asking', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes'], t!.ctx);
      const asked: string[] = [];
      t!.ctx.cwd = dir;
      t!.ctx.interactive = true;
      t!.ctx.ask = (prompt) => {
        asked.push(prompt);
        return Promise.resolve('');
      };
      await run(['init'], t!.ctx);
      expect(asked[0]).toContain('[.]');
    });

    it('still defaults to ./briefroom in a folder that is not an install', async () => {
      const { dir } = await setup();
      await mkdir(dir, { recursive: true });
      t!.ctx.cwd = dir;
      await run(['init', '--yes'], t!.ctx);
      expect((await readEnv(join(dir, 'briefroom'))).BETTER_AUTH_SECRET).toMatch(BASE64URL_43);
    });
  });

  describe('secrets on an existing .env', () => {
    it('keeps secrets written with an export prefix and does not append a second line', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes'], t!.ctx);
      const first = await readEnv(dir);
      const text = await readFile(join(dir, '.env'), 'utf8');
      await writeFile(join(dir, '.env'), text.replace(/^(POSTGRES_PASSWORD=)/m, 'export $1'));
      await run(['init', dir, '--yes', '--port', '4900'], t!.ctx);
      const after = await readFile(join(dir, '.env'), 'utf8');
      expect(parseEnv(after).POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
      expect(after.match(/POSTGRES_PASSWORD=/g)).toHaveLength(1);
      expect(after).toContain('export POSTGRES_PASSWORD=');
    });

    it.each(SECRETS)('stops and names %s when it is empty', async (key) => {
      const { dir } = await setup();
      await run(['init', dir, '--yes'], t!.ctx);
      const text = await readFile(join(dir, '.env'), 'utf8');
      const broken = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=`);
      await writeFile(join(dir, '.env'), broken);
      expect(await run(['init', dir, '--yes'], t!.ctx)).toBe(1);
      expect(t!.stderr.join('')).toContain(key);
      expect(await readFile(join(dir, '.env'), 'utf8')).toBe(broken);
    });

    it('stops when a secret is absent from an .env that already exists', async () => {
      const { dir } = await setup();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.env'), 'PORT=4300\n');
      expect(await run(['init', dir, '--yes'], t!.ctx)).toBe(1);
      expect(t!.stderr.join('')).toContain('POSTGRES_PASSWORD');
    });
  });

  describe('switching from the local network back to this computer', () => {
    const DOCKER = '/usr/bin/docker';

    async function lanInstall(overrides: Parameters<typeof testContext>[0]) {
      t = await testContext({
        fetch: fakeFetch([]),
        networkInterfaces: lanInterfaces,
        ...overrides,
      });
      const dir = join(t.home, 'install');
      await run(['init', dir, '--yes', '--lan'], t.ctx);
      t.stdout.length = 0;
      return dir;
    }

    it('removes the caddy container through docker compose in the install folder', async () => {
      const calls: { file: string; args: string[]; cwd: string }[] = [];
      const dir = await lanInstall({
        resolveCommand: (name) => (name === 'docker' ? DOCKER : null),
        runInherited: (file, args, cwd) => {
          calls.push({ file, args, cwd });
          return Promise.resolve(0);
        },
      });
      expect(await run(['init', dir, '--yes', '--local'], t!.ctx)).toBe(0);
      expect(calls).toEqual([{ file: DOCKER, args: ['compose', 'rm', '-sf', 'caddy'], cwd: dir }]);
      expect(t!.stdout.join('')).toContain('Stopped Caddy');
    });

    it('prints the exact command when docker is not found', async () => {
      const calls: string[] = [];
      const dir = await lanInstall({
        resolveCommand: () => null,
        runInherited: (file) => {
          calls.push(file);
          return Promise.resolve(0);
        },
      });
      expect(await run(['init', dir, '--yes', '--local'], t!.ctx)).toBe(0);
      expect(calls).toEqual([]);
      expect(t!.stdout.join('')).toContain('docker compose rm -sf caddy');
    });

    it('prints the command when docker fails', async () => {
      const dir = await lanInstall({
        resolveCommand: () => DOCKER,
        runInherited: () => Promise.resolve(1),
      });
      expect(await run(['init', dir, '--yes', '--local'], t!.ctx)).toBe(0);
      expect(t!.stdout.join('')).toContain('docker compose rm -sf caddy');
    });

    it('does not touch docker when caddy was never on', async () => {
      const calls: string[] = [];
      const { dir } = await setup();
      t!.ctx.resolveCommand = () => DOCKER;
      t!.ctx.runInherited = (file) => {
        calls.push(file);
        return Promise.resolve(0);
      };
      await run(['init', dir, '--yes'], t!.ctx);
      await run(['init', dir, '--yes', '--local'], t!.ctx);
      expect(calls).toEqual([]);
    });
  });

  describe('output', () => {
    const QR_BLOCKS = /[▀▄█]/;

    it('tells LAN installs how to get and trust the Caddy root certificate', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes', '--lan'], t!.ctx);
      const out = t!.stdout.join('');
      expect(out).toContain(
        'docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./briefroom-root.crt',
      );
      expect(out).toContain('NODE_EXTRA_CA_CERTS');
      expect(out).toMatch(QR_BLOCKS);
    });

    it('prints the address without a QR code when the host is loopback', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes'], t!.ctx);
      const out = t!.stdout.join('');
      expect(out).toContain('http://localhost:4300');
      expect(out).not.toMatch(QR_BLOCKS);
      expect(out).not.toContain('NODE_EXTRA_CA_CERTS');
      t!.stdout.length = 0;
      await run(['init', dir, '--yes', '--lan', '--host', '127.0.0.1'], t!.ctx);
      expect(t!.stdout.join('')).not.toMatch(QR_BLOCKS);
    });

    it('asks again for an answer it does not recognise and never reads it as local', async () => {
      const { dir } = await setup();
      await run(['init', dir, '--yes', '--lan'], t!.ctx);
      const answers = [dir, '', 'lan', 'network', '1'];
      t!.ctx.interactive = true;
      const asked: string[] = [];
      t!.ctx.ask = (prompt) => {
        asked.push(prompt);
        return Promise.resolve(answers.shift() ?? '');
      };
      expect(await run(['init'], t!.ctx)).toBe(0);
      expect(asked.filter((p) => p.includes('Who needs to reach'))).toHaveLength(3);
      expect(t!.stderr.join('')).toContain('"lan" is not an answer');
      expect((await readEnv(dir)).COMPOSE_PROFILES).toBe('');
    });
  });
});
