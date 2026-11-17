import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.ts';
import { refuseSymlink, writeFileReplacing } from './fs-safe.ts';

export interface WorkspaceCredential {
  name: string;
  token: string;
}

/**
 * Keyed by the normalised base URL the user typed, because that is where the token is sent.
 * `installId` is what that address reported when the entry was made, and is only checked, never trusted for routing.
 */
export interface InstallCredentials {
  installId: string;
  workspaces: Record<string, WorkspaceCredential>;
}

export interface Credentials {
  installs: Record<string, InstallCredentials>;
}

export function credentialsPath(home: string): string {
  return join(home, '.briefroom', 'credentials.json');
}

export async function loadCredentials(home: string): Promise<Credentials> {
  await refuseSymlink(credentialsPath(home));
  let raw: string;
  try {
    raw = await readFile(credentialsPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { installs: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (parsed && typeof parsed.installs === 'object' && parsed.installs !== null) {
      return { installs: parsed.installs };
    }
  } catch {
    // falls through to the error below
  }
  throw new CliError(`${credentialsPath(home)} is not valid. Delete it and run briefroom login.`);
}

// Modes are best effort: on Windows chmod only toggles the read-only flag, and the profile
// folder's own ACL is what keeps other users out. A failure here never blocks a login.
async function tryChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // not supported on this filesystem
  }
}

export async function saveCredentials(home: string, credentials: Credentials): Promise<void> {
  const dir = join(home, '.briefroom');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tryChmod(dir, 0o700);
  await writeFileReplacing(
    credentialsPath(home),
    `${JSON.stringify(credentials, null, 2)}\n`,
    0o600,
  );
}

export async function saveWorkspaceToken(
  home: string,
  install: { installId: string; baseUrl: string },
  workspaceId: string,
  credential: WorkspaceCredential,
): Promise<void> {
  const credentials = await loadCredentials(home);
  const existing = credentials.installs[install.baseUrl];
  // An address that answers as a different install than before must not take over the saved tokens.
  if (existing && existing.installId !== install.installId) {
    throw new CliError(
      `${install.baseUrl} now reports a different install than the one saved. Run briefroom disconnect --all first if that is expected.`,
    );
  }
  credentials.installs[install.baseUrl] = {
    installId: install.installId,
    workspaces: { ...existing?.workspaces, [workspaceId]: credential },
  };
  await saveCredentials(home, credentials);
}

export async function removeWorkspaceToken(
  home: string,
  baseUrl: string,
  workspaceId: string,
): Promise<void> {
  const credentials = await loadCredentials(home);
  const install = credentials.installs[baseUrl];
  if (!install) return;
  delete install.workspaces[workspaceId];
  if (Object.keys(install.workspaces).length === 0) delete credentials.installs[baseUrl];
  await saveCredentials(home, credentials);
}
