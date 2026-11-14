import type { IncomingMessage, ServerResponse } from 'node:http';

// Reset links carry a secret in the URL path, so no response may let it leak through the Referer header.
export function referrerPolicyMiddleware(
  _req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
