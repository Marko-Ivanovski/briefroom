// Methods that keep a response open after the call that started it. Such a stream outlives a
// revoked token or a removed member, and a handful of them lock the method for everyone.
const LONG_LIVED_METHODS = new Set(['subscriptions/listen']);

/** The JSON-RPC request id of the first long-lived stream request in a body, or undefined when there is none. */
export function longLivedStreamRequest(body: unknown): { id: string | number | null } | undefined {
  for (const message of Array.isArray(body) ? body : [body]) {
    if (typeof message !== 'object' || message === null) continue;
    const { method, id } = message as { method?: unknown; id?: unknown };
    if (typeof method === 'string' && LONG_LIVED_METHODS.has(method)) {
      return { id: typeof id === 'string' || typeof id === 'number' ? id : null };
    }
  }
  return undefined;
}

export function methodNotFoundBody(id: string | number | null): object {
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

/** A parsed JSON-RPC object, or a non-empty batch. Anything else never reaches the MCP handler. */
export function isJsonRpcBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0;
  return typeof body === 'object' && body !== null && Object.keys(body).length > 0;
}
