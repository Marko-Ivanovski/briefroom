import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.ts';

export interface WorkspaceCredential {
  name: string;
  token: string;
}

export interface InstallCredentials {
  baseUrl: string;
  workspaces: Record<string, WorkspaceCredential>;
}

export interface Credentials {
  installs: Record<string, InstallCredentials>;
}

export function credentialsPath(home: string): string {
  return join(home, '.briefroom', 'credentials.json');
}

export async function loadCredentials(home: string): Promise<Credentials> {
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
  const file = credentialsPath(home);
  const dir = join(home, '.briefroom');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tryChmod(dir, 0o700);
  // Written to a temp file that is already 600 and then renamed, so the token is never readable by others.
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  await tryChmod(file, 0o600);
}

export async function saveWorkspaceToken(
  home: string,
  install: { installId: string; baseUrl: string },
  workspaceId: string,
  credential: WorkspaceCredential,
): Promise<void> {
  const credentials = await loadCredentials(home);
  const existing = credentials.installs[install.installId];
  credentials.installs[install.installId] = {
    baseUrl: install.baseUrl,
    workspaces: { ...existing?.workspaces, [workspaceId]: credential },
  };
  await saveCredentials(home, credentials);
}

export async function removeWorkspaceToken(
  home: string,
  installId: string,
  workspaceId: string,
): Promise<void> {
  const credentials = await loadCredentials(home);
  const install = credentials.installs[installId];
  if (!install) return;
  delete install.workspaces[workspaceId];
  if (Object.keys(install.workspaces).length === 0) delete credentials.installs[installId];
  await saveCredentials(home, credentials);
}
