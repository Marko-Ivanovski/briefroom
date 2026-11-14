const KEY = 'briefroom.lastWorkspace';

export function readLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeLastWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(KEY, workspaceId);
  } catch {
    // Storage can be blocked. The first workspace is the fallback.
  }
}

export function pickWorkspace(workspaces: { id: string }[]): string | null {
  const last = readLastWorkspace();
  return workspaces.find((w) => w.id === last)?.id ?? workspaces[0]?.id ?? null;
}
