export class InvalidRemoteError extends Error {
  constructor() {
    super('Not a valid git remote');
    this.name = 'InvalidRemoteError';
  }
}

const SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ssh:', 'git:']);
// user@host:owner/repo, the form git prints for ssh remotes. The (?!\/\/) keeps real URLs out.
const SCP_LIKE = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)(.+)$/;

function hostAndPath(input: string): { host: string; path: string } {
  const scp = SCP_LIKE.exec(input);
  if (scp) return { host: scp[2]!, path: scp[3]! };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidRemoteError();
  }
  if (!SCHEMES.has(url.protocol)) throw new InvalidRemoteError();
  return { host: url.hostname, path: url.pathname };
}

/** `host/owner/repo` in lowercase, without credentials, port, scheme or a trailing `.git`. */
export function normalizeRemote(remote: string): string {
  const input = remote.trim();
  if (!input) throw new InvalidRemoteError();
  const { host, path } = hostAndPath(input);
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (!host || segments.length < 2 || segments.some((s) => !s)) throw new InvalidRemoteError();
  return `${host}/${segments.join('/')}`.toLowerCase();
}

/**
 * The form that is stored and returned. A password in a remote URL must never reach the
 * database. A user name without a password (`git@host`, `ssh://git@host`) is only a login and stays.
 */
export function stripCredentials(remote: string): string {
  const input = remote.trim();
  const scp = SCP_LIKE.exec(input);
  if (scp) return scp[1]?.includes(':') ? `${scp[2]}:${scp[3]}` : input;
  return input.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)@/i,
    (all, scheme: string, userinfo: string) => (userinfo.includes(':') ? scheme : all),
  );
}
