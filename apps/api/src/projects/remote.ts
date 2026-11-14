export class InvalidRemoteError extends Error {
  constructor() {
    super('Not a valid git remote');
    this.name = 'InvalidRemoteError';
  }
}

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'git:']);
// Over ssh a bare username is a login. Over http(s) it is often a token.
const SSH_PROTOCOLS: ReadonlySet<string> = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;
// user@host:owner/repo, the form git prints for ssh remotes. Neither part may hold `@` or `:`.
const SCP_FORM = /^(?:([^@:/\s]+)@)?([^@:/\s]+):([^\s]+)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const LOGIN_NAME = /^[\w.-]+$/;

interface ParsedRemote {
  host: string;
  path: string;
  /** The remote as it is stored and returned: never carries a password or a token. */
  stored: string;
}

function parseUrlForm(input: string): ParsedRemote {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidRemoteError();
  }
  const ssh = SSH_PROTOCOLS.has(url.protocol);
  if (!ssh && !WEB_PROTOCOLS.has(url.protocol)) throw new InvalidRemoteError();

  // Any password drops the whole userinfo. Only a passwordless ssh login stays.
  if (!ssh || url.password) url.username = '';
  url.password = '';
  // Tokens also get pasted as ?access_token=… or #…, and neither belongs to the repo identity.
  url.search = '';
  url.hash = '';
  // A kept login must be a plain name. Anything odd that survived parsing is refused, not stored.
  if (url.username && !LOGIN_NAME.test(url.username)) throw new InvalidRemoteError();
  return { host: url.hostname, path: url.pathname, stored: url.toString() };
}

function parseScpForm(input: string): ParsedRemote {
  if (WINDOWS_DRIVE.test(input)) throw new InvalidRemoteError();
  const scp = SCP_FORM.exec(input);
  const path = scp?.[3];
  if (
    !scp ||
    path === undefined ||
    path.startsWith('//') ||
    /[@:]/.test(path) ||
    (scp[1] !== undefined && !LOGIN_NAME.test(scp[1]))
  ) {
    throw new InvalidRemoteError();
  }
  return { host: scp[2]!, path, stored: input };
}

function parseRemote(remote: string): ParsedRemote {
  const input = remote.trim();
  if (!input) throw new InvalidRemoteError();
  return URL_FORM.test(input) ? parseUrlForm(input) : parseScpForm(input);
}

// Decoding per segment keeps %2F from turning one segment into two, which would let two spellings
// of different repos collide, and lets two spellings of one repo match.
function decode(part: string): string {
  try {
    const decoded = decodeURIComponent(part);
    if (decoded.includes('/') || decoded.includes('\\')) throw new InvalidRemoteError();
    return decoded;
  } catch {
    throw new InvalidRemoteError();
  }
}

/** `host/owner/repo` in lowercase, without credentials, port, scheme or a trailing `.git`. */
export function normalizeRemote(remote: string): string {
  const parsed = parseRemote(remote);
  const segments = parsed.path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
    .map(decode);
  const host = decode(parsed.host);
  if (!host || segments.length < 2 || segments.some((s) => !s)) throw new InvalidRemoteError();
  return `${host}/${segments.join('/')}`.toLowerCase();
}

/**
 * The form that is stored and returned, from the same parse that accepts the remote. A password
 * never survives, and neither does a username over http(s). An ssh or scp login without a
 * password stays. Input that cannot be cleaned is refused.
 */
export function stripCredentials(remote: string): string {
  return parseRemote(remote).stored;
}
