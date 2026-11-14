import type { ZodObject } from 'zod';

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

/** Parses one field on its own. A missing or invalid value falls back to that field's default. */
function readField(schema: ZodObject, key: string, value: unknown): unknown {
  const field = schema.shape[key]!;
  const parsed = field.safeParse(value);
  return parsed.success ? parsed.data : field.safeParse(undefined).data;
}

/**
 * R114: settings are read field by field, so one stored value that no longer fits does not drop
 * the valid ones, and a field never saved follows the manifest's current default.
 */
export function readSettings(schema: ZodObject, stored: unknown): Raw {
  const raw = asRaw(stored);
  return Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, readField(schema, k, raw[k])]),
  );
}

/**
 * R114: only fields an admin submitted are stored. The stored values that still fit are kept, the
 * merge is validated against the full schema, and unknown keys are dropped.
 */
export function mergeSubmittedSettings(
  schema: ZodObject,
  stored: unknown,
  submitted: Raw,
): { ok: true; value: Raw } | { ok: false } {
  const keys = new Set(Object.keys(schema.shape));
  const kept = Object.fromEntries(
    Object.entries(asRaw(stored)).filter(
      ([k, v]) => keys.has(k) && schema.shape[k]!.safeParse(v).success,
    ),
  );
  const explicit = Object.fromEntries(Object.entries(submitted).filter(([k]) => keys.has(k)));
  const merged = { ...kept, ...explicit };
  if (!schema.safeParse(merged).success) return { ok: false };
  const value = Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k, schema.shape[k]!.parse(v)]),
  );
  return { ok: true, value };
}
