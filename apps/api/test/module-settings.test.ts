import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeSubmittedSettings, readSettings } from '../src/module-registry/module-settings.ts';

const schema = (grid: number) =>
  z.object({
    title: z.string().max(10).default('Board'),
    grid: z.number().int().min(1).default(grid),
    dense: z.boolean().default(false),
  });

describe('readSettings', () => {
  it('fills every missing field with its own default', () => {
    expect(readSettings(schema(8), {})).toEqual({ title: 'Board', grid: 8, dense: false });
    expect(readSettings(schema(8), null)).toEqual({ title: 'Board', grid: 8, dense: false });
  });

  it('keeps the valid fields when one stored field no longer fits', () => {
    const stored = { title: 'x'.repeat(11), grid: 3, dense: true };
    expect(readSettings(schema(8), stored)).toEqual({ title: 'Board', grid: 3, dense: true });
  });

  it('lets a later default change reach a workspace that never saved the field', () => {
    const stored = { title: 'Mine' };
    expect(readSettings(schema(8), stored).grid).toBe(8);
    expect(readSettings(schema(12), stored)).toEqual({ title: 'Mine', grid: 12, dense: false });
  });
});

describe('mergeSubmittedSettings', () => {
  it('stores only the submitted fields, not the defaults', () => {
    const merged = mergeSubmittedSettings(schema(8), {}, { grid: 4 });
    expect(merged).toEqual({ ok: true, value: { grid: 4 } });
  });

  it('keeps previously stored fields and drops unknown keys', () => {
    const merged = mergeSubmittedSettings(schema(8), { title: 'Mine' }, { grid: 4, extra: 1 });
    expect(merged).toEqual({ ok: true, value: { title: 'Mine', grid: 4 } });
  });

  it('refuses a submitted field that does not fit', () => {
    expect(mergeSubmittedSettings(schema(8), {}, { grid: 0 }).ok).toBe(false);
  });

  it('is not blocked by a stored field that no longer fits', () => {
    const stored = { title: 'x'.repeat(11) };
    expect(mergeSubmittedSettings(schema(8), stored, { grid: 2 })).toEqual({
      ok: true,
      value: { grid: 2 },
    });
  });
});
