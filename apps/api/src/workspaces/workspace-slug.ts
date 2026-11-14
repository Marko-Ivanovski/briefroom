import { randomBytes } from 'node:crypto';

export function workspaceSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'workspace';
  return `${base}-${randomBytes(3).toString('hex')}`;
}
