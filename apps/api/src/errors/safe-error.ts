/**
 * A log-safe description of an error. Drizzle's DrizzleQueryError message holds the SQL and its
 * parameters (emails, hashes, tokens), so only the error name and the Postgres code are ever logged.
 */
export function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = pgCodeOf(err);
  return code ? `${name} (pg ${code})` : name;
}

function pgCodeOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
