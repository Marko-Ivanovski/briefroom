export class InvalidRemoteError extends Error {
  constructor() {
    super('Not a valid git remote');
    this.name = 'InvalidRemoteError';
  }
}

const SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ssh:', 'git:']);
// user@host:owner/repo, the form git prints for ssh remotes. The (?!\/\/) keeps real URLs out.
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

function hostAndPath(input: string): { host: string; path: string } {
  const scp = SCP_LIKE.exec(input);
  if (scp) return { host: scp[1]!, path: scp[2]! };
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
