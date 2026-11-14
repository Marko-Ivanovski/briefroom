import { z } from 'zod';
import type { ModuleManifest } from './manifest.ts';

export class ModuleManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleManifestError';
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const ManifestShape = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'must match /^[a-z][a-z0-9-]{1,30}$/'),
  name: z.string().min(1),
  version: z.string().regex(SEMVER, 'must be a semantic version'),
  description: z.string().min(1),
  permissions: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'must match /^[a-z][a-z0-9-]{1,40}$/'),
      label: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  contentLevels: z.array(z.enum(['workspace', 'project'])).min(1, 'needs at least one level'),
  tables: z.array(z.custom((v) => typeof v === 'object' && v !== null)).min(1, 'must not be empty'),
  settings: z.instanceof(z.ZodObject).optional(),
});

/** Validates a manifest at import time, so a bad module fails the boot rather than a request. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  const parsed = ManifestShape.safeParse(manifest);
  const label = typeof manifest?.id === 'string' ? manifest.id : '(no id)';
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`)
      .join('; ');
    throw new ModuleManifestError(`Invalid module manifest "${label}": ${issues}`);
  }

  const seen = new Set<string>();
  for (const { key } of manifest.permissions) {
    if (seen.has(key)) {
      throw new ModuleManifestError(
        `Invalid module manifest "${label}": duplicate permission "${key}"`,
      );
    }
    seen.add(key);
  }

  if (manifest.settings) {
    const defaults = manifest.settings.safeParse({});
    if (!defaults.success) {
      const fields = defaults.error.issues.map((i) => i.path.join('.')).join(', ');
      throw new ModuleManifestError(
        `Invalid module manifest "${label}": every settings field needs a default (${fields})`,
      );
    }
  }
  return manifest;
}
