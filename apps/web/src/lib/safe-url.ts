/** Stored URLs only become links when they are http or https. */
export function safeHttpUrl(value: string): string | null {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function openInNewTab(url: string): void {
  const safe = safeHttpUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}
