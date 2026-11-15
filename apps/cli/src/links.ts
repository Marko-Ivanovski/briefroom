import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from './errors.ts';
import { refuseSymlink, writeFileReplacing } from './fs-safe.ts';

export interface LinkRecord {
  baseUrl: string;
  installId: string;
  workspaceId: string;
  linkedAt: string;
}

/** Which repositories this machine has linked, keyed by the repo root's real absolute path. */
export interface LinkRecords {
  links: Record<string, LinkRecord>;
}

export function linksPath(home: string): string {
  return join(home, '.briefroom', 'links.json');
}

export async function loadLinks(home: string): Promise<LinkRecords> {
  await refuseSymlink(linksPath(home));
  let raw: string;
  try {
    raw = await readFile(linksPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { links: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LinkRecords>;
    if (parsed && typeof parsed.links === 'object' && parsed.links !== null) {
      return { links: parsed.links };
    }
  } catch {
    // falls through to the error below
  }
  throw new CliError(`${linksPath(home)} is not valid. Delete it and run briefroom link again.`);
}

async function saveLinks(home: string, records: LinkRecords): Promise<void> {
  const dir = join(home, '.briefroom');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  await writeFileReplacing(linksPath(home), `${JSON.stringify(records, null, 2)}\n`, 0o600);
}

export async function recordLink(
  home: string,
  repoRealPath: string,
  link: Omit<LinkRecord, 'linkedAt'>,
  now: () => number = Date.now,
): Promise<void> {
  const records = await loadLinks(home);
  records.links[repoRealPath] = { ...link, linkedAt: new Date(now()).toISOString() };
  await saveLinks(home, records);
}

/** Drops every record that points at this address and workspace. */
export async function removeLinksFor(
  home: string,
  baseUrl: string,
  workspaceId: string,
): Promise<void> {
  const records = await loadLinks(home);
  let changed = false;
  for (const [root, record] of Object.entries(records.links)) {
    if (record.baseUrl === baseUrl && record.workspaceId === workspaceId) {
      delete records.links[root];
      changed = true;
    }
  }
  if (changed) await saveLinks(home, records);
}
