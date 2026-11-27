import { mkdir, readFile, stat } from 'node:fs/promises';
import type { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import pkg from '../../package.json' with { type: 'json' };
import type { Context } from '../context.ts';
import { CliError } from '../errors.ts';
import { refuseSymlink, writeFileReplacing } from '../fs-safe.ts';
import { generateSecret, mergeEnv, parseEnv } from '../env-file.ts';

const RELEASE_BASE = 'https://github.com/marko-ivanovski/briefroom/releases/download';
const RELEASE_FILES = ['compose.yml', 'Caddyfile'] as const;
const SECRET_KEYS = ['BETTER_AUTH_SECRET', 'BRIEFROOM_SECRET_KEY', 'POSTGRES_PASSWORD'] as const;
const DEFAULT_DIR = './briefroom';
const DEFAULT_PORT = '4300';
const DEFAULT_HTTPS_PORT = '443';
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const STOP_CADDY_ARGS = ['compose', 'rm', '-sf', 'caddy'];
const ROOT_CERT = 'briefroom-root.crt';

export interface InitOptions {
  yes?: boolean;
  port?: string;
  lan?: boolean;
  local?: boolean;
  host?: string;
}

type Interfaces = ReturnType<typeof networkInterfaces>;

export function firstLanIPv4(interfaces: Interfaces): string | null {
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function validPort(value: string): string {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 65535) {
    throw new CliError(`${value} is not a port. Use a number from 1 to 65535.`);
  }
  return String(n);
}

// The host lands in .env and in a URL, so only a plain name or address is accepted.
function validHost(value: string): string {
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
    throw new CliError(`${value} is not a host name or IPv4 address.`);
  }
  return value;
}

async function readExisting(path: string): Promise<string | null> {
  await refuseSymlink(path);
  return readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

/** The folder already holds an install, so re-running init there must reuse it and keep its secrets. */
async function holdsInstall(dir: string): Promise<boolean> {
  const hasCompose = await stat(join(dir, 'compose.yml')).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!hasCompose) return false;
  return !!parseEnv((await readExisting(join(dir, '.env'))) ?? '').BETTER_AUTH_SECRET;
}

async function download(ctx: Context, name: string): Promise<string> {
  const url = `${RELEASE_BASE}/v${pkg.version}/${name}`;
  let res: Response;
  try {
    res = await ctx.fetch(url);
  } catch (err) {
    throw new CliError(`Could not download ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new CliError(`Could not download ${url} (HTTP ${res.status}).`);
  return res.text();
}

async function askOr(ctx: Context, prompt: string, fallback: string): Promise<string> {
  return (await ctx.ask(`${prompt} [${fallback}]: `)).trim() || fallback;
}

async function askReach(ctx: Context, lan: boolean): Promise<boolean> {
  for (;;) {
    const answer = await askOr(
      ctx,
      `Who needs to reach Briefroom?\n  1) This computer\n  2) Local network\nNumber`,
      lan ? '2' : '1',
    );
    if (answer === '1' || /^this computer$/i.test(answer)) return false;
    if (answer === '2' || /^local network$/i.test(answer)) return true;
    ctx.err(`"${answer}" is not an answer. Type 1 or 2.\n`);
  }
}

// Compose leaves a running service alone when its profile is switched off, so Caddy is removed here.
async function stopCaddy(ctx: Context, dir: string, dirText: string): Promise<void> {
  const docker = ctx.resolveCommand('docker');
  if (docker) {
    const code = await ctx.runInherited(docker, STOP_CADDY_ARGS, dir).catch(() => 1);
    if (code === 0) {
      ctx.out('Stopped Caddy, so the local network can no longer reach Briefroom.\n\n');
      return;
    }
  }
  ctx.out(
    `Caddy may still be serving the local network. Stop it with:\n  cd ${dirText}\n  docker compose rm -sf caddy\n\n`,
  );
}

export async function init(
  ctx: Context,
  dirArg: string | undefined,
  options: InitOptions,
): Promise<void> {
  if (options.lan && options.local) throw new CliError('Pick one of --lan and --local.');
  const asking = ctx.interactive && !options.yes;

  const defaultDir = dirArg === undefined && (await holdsInstall(ctx.cwd)) ? '.' : DEFAULT_DIR;
  const dirText = dirArg ?? (asking ? await askOr(ctx, 'Folder', defaultDir) : defaultDir);
  const dir = resolve(ctx.cwd, dirText);
  const envPath = join(dir, '.env');
  const existingText = await readExisting(envPath);
  const existing = parseEnv(existingText ?? '');

  const port = validPort(
    options.port ??
      (asking
        ? await askOr(ctx, 'Port', existing.PORT || DEFAULT_PORT)
        : existing.PORT || DEFAULT_PORT),
  );

  const wasLan = existing.COMPOSE_PROFILES?.split(',').includes('lan') ?? false;
  let lan = wasLan;
  if (options.lan) lan = true;
  else if (options.local) lan = false;
  else if (asking) lan = await askReach(ctx, lan);

  const set: Record<string, string> = {
    PORT: port,
    BRIEFROOM_VERSION: pkg.version,
    // Caddy is the only LAN listener, so the plain-http app port stays on this computer.
    BRIEFROOM_BIND: '127.0.0.1',
    COMPOSE_PROFILES: lan ? 'lan' : '',
    BRIEFROOM_HOST: '',
    BRIEFROOM_PUBLIC_URL: `http://localhost:${port}`,
  };

  if (lan) {
    const detected = existing.BRIEFROOM_HOST || firstLanIPv4(ctx.networkInterfaces());
    let host = options.host ?? detected;
    if (asking && options.host === undefined) {
      host = await askOr(ctx, 'Address clients will use for Briefroom (host)', detected ?? '');
    }
    if (!host) throw new CliError('No network address found. Pass one with --host.');
    set.BRIEFROOM_HOST = validHost(host);
    const httpsPort = /^\d+$/.test(existing.BRIEFROOM_HTTPS_PORT ?? '')
      ? (existing.BRIEFROOM_HTTPS_PORT as string)
      : DEFAULT_HTTPS_PORT;
    set.BRIEFROOM_HTTPS_PORT = httpsPort;
    set.BRIEFROOM_PUBLIC_URL = `https://${set.BRIEFROOM_HOST}${httpsPort === DEFAULT_HTTPS_PORT ? '' : `:${httpsPort}`}`;
  }

  // A new secret on an existing install locks the app out of its database, drops every session and
  // makes the stored tunnel token unreadable, so only a fresh install gets secrets.
  if (existingText === null) {
    for (const key of SECRET_KEYS) set[key] = generateSecret();
  } else {
    const missing = SECRET_KEYS.filter((key) => !existing[key]);
    if (missing.length > 0) {
      throw new CliError(
        `${envPath} has no value for ${missing.join(', ')}. Restore it from your backup. init never makes a new one for an existing install.`,
      );
    }
  }

  // Fetch both before writing anything, so a failed download leaves the folder as it was.
  const files = await Promise.all(RELEASE_FILES.map((name) => download(ctx, name)));

  await mkdir(dir, { recursive: true });
  await writeFileReplacing(envPath, mergeEnv(existingText, set), 0o600);
  for (const [i, name] of RELEASE_FILES.entries()) {
    await writeFileReplacing(join(dir, name), files[i] as string, 0o644);
  }

  const address = set.BRIEFROOM_PUBLIC_URL as string;
  ctx.out(`Wrote ${envPath}, compose.yml and Caddyfile (Briefroom v${pkg.version}).\n\n`);
  if (wasLan && !lan) await stopCaddy(ctx, dir, dirText);
  ctx.out(`Start it:\n  cd ${dirText}\n  docker compose up -d\n\n`);
  ctx.out(`Then open ${address}\n`);
  if (lan) {
    ctx.out(
      `\nCaddy signs the certificate with its own CA, so a browser warns until it trusts that root.\n` +
        `After the first start, copy the root certificate out:\n` +
        `  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./${ROOT_CERT}\n` +
        `Install it on each device. For the CLI and agents, set NODE_EXTRA_CA_CERTS to its path.\n`,
    );
  }
  // A phone cannot open a loopback address, so the QR code would only mislead.
  if (!LOOPBACK_HOST.test(new URL(address).hostname)) {
    ctx.out(`\n${await QRCode.toString(address, { type: 'terminal', small: true })}`);
  }
}
