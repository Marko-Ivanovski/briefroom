/** Stored URLs only become links when they are http or https. */
export function safeHttpUrl(value: string): string | null {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
