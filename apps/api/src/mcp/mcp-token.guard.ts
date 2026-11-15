import {
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { AccessService } from '../access/access.service.ts';
import type { Scope } from '../access/scope.ts';
import { RefusedAttemptLimiter } from '../rate-limit/rate-limit.ts';
import { TokensService } from '../tokens/tokens.service.ts';

const TOKEN_HEADER = /^Bearer (brf_\S+)$/;
const MAX_AGENT_LENGTH = 40;

/** R147: lowercase, only a-z, 0-9 and `-`, at most 40 characters, `unknown` when nothing is left. */
export function normalizeAgent(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_AGENT_LENGTH);
  return cleaned || 'unknown';
}

// Streams that stay open after the call that started them. They outlive a revoked token or a removed member.
const LONG_LIVED_METHODS = new Set(['subscriptions/listen']);

interface McpRequest {
  headers: IncomingHttpHeaders;
  method?: string;
  body?: unknown;
  scope?: Scope;
  tokenId?: string;
}

/**
 * R146: /mcp, and the CLI's delete of its own token, take a Bearer brf_ token and nothing else. The route is anonymous to the session
 * guard, so a session cookie is never read here. Every refusal looks the same to the caller.
 */
@Injectable()
export class McpTokenGuard implements CanActivate {
  private readonly log = new Logger('McpAuth');

  constructor(
    private readonly tokens: TokensService,
    private readonly access: AccessService,
    private readonly limiter: RefusedAttemptLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<McpRequest>();
    // A blocked address gets 429 before anything is read or verified.
    this.limiter.assertAllowed(req.headers);
    const token = TOKEN_HEADER.exec(req.headers.authorization ?? '')?.[1];
    const verified = token ? await this.tokens.verify(token) : null;
    const scope = verified
      ? await this.access.scopeFor(
          verified.userId,
          verified.workspaceId,
          'mcp',
          normalizeAgent(req.headers['x-briefroom-agent']),
        )
      : null;
    if (!scope) return this.refuse(req, token ? 'invalid token' : 'no bearer token');
    req.scope = scope;
    req.tokenId = verified?.tokenId;
    this.refuseLongLivedStreams(req);
    return true;
  }

  private refuseLongLivedStreams(req: McpRequest): void {
    if (req.method !== 'POST') return;
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    const refused = messages.find(
      (m): m is { id?: unknown; method: string } =>
        typeof m === 'object' &&
        m !== null &&
        LONG_LIVED_METHODS.has((m as { method?: unknown }).method as string),
    );
    if (!refused) return;
    const id = typeof refused.id === 'string' || typeof refused.id === 'number' ? refused.id : null;
    throw new HttpException(
      { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } },
      404,
    );
  }

  // The reason goes to the log only. The response never says why.
  private async refuse(req: McpRequest, reason: string): Promise<never> {
    this.log.warn(`Refused MCP request: ${reason}`);
    await this.limiter.record(req.headers);
    throw new UnauthorizedException({
      code: 'unauthorized',
      message: 'A valid token is required.',
    });
  }
}
