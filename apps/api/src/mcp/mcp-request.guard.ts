import {
  BadRequestException,
  HttpException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isJsonRpcBody, longLivedStreamRequest, methodNotFoundBody } from './mcp-streams.ts';

interface McpRequest {
  method?: string;
  body?: unknown;
}

/**
 * Runs after McpTokenGuard and fails closed: the endpoint is stateless, so only a POST carrying a
 * parsed JSON-RPC body is dispatched. GET would open a standalone SSE stream, and a stream method
 * in a POST would hold a connection open past a revocation.
 */
@Injectable()
export class McpRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<McpRequest>();
    if (req.method !== 'POST') {
      context
        .switchToHttp()
        .getResponse<{ setHeader(name: string, value: string): void }>()
        .setHeader('Allow', 'POST');
      throw new HttpException(
        { code: 'method_not_allowed', message: 'Use POST for MCP requests.' },
        405,
      );
    }
    if (!isJsonRpcBody(req.body)) {
      throw new BadRequestException({
        code: 'invalid_request',
        message: 'The body must be a JSON-RPC object or a non-empty array.',
      });
    }
    const stream = longLivedStreamRequest(req.body);
    if (stream) throw new HttpException(methodNotFoundBody(stream.id), 404);
    return true;
  }
}
