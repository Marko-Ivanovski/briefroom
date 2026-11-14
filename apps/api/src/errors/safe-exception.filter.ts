import { STATUS_CODES, type ServerResponse } from 'node:http';
import { BUSY_RETRY_AFTER_SECONDS, BusyException } from '../files/semaphore.ts';
import { Catch, HttpStatus, Logger, type ArgumentsHost, type HttpServer } from '@nestjs/common';
import { BaseExceptionFilter, type AbstractHttpAdapter } from '@nestjs/core';
import { isAPIError } from 'better-auth/api';
import { SAFE_AUTH_MESSAGES } from '../auth/auth.ts';
import { describeError } from './safe-error.ts';

/**
 * Replaces Nest's default filter, which logs the whole exception. For a failed query that includes
 * the SQL parameters, so unknown errors are logged by name only and a Better Auth APIError keeps its
 * own status instead of turning into a 500. HttpExceptions behave exactly as in Nest.
 */
@Catch()
export class SafeExceptionFilter extends BaseExceptionFilter {
  private readonly log = new Logger('ExceptionsHandler');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof BusyException) {
      host
        .switchToHttp()
        .getResponse<ServerResponse>()
        .setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
    }
    super.catch(exception, host);
  }

  override handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: AbstractHttpAdapter | HttpServer,
  ): void {
    const { status, message } = this.describe(exception);
    const response = host.getArgByIndex(1);
    if (!applicationRef.isHeadersSent(response)) {
      applicationRef.reply(response, { statusCode: status, message }, status);
    } else {
      applicationRef.end(response);
    }
  }

  private describe(exception: unknown): { status: number; message: string } {
    if (isAPIError(exception)) {
      const status = exception.statusCode;
      const line = `${exception.name} ${status}`;
      if (status >= 500) this.log.error(line);
      else this.log.warn(line);
      const own = typeof exception.body?.message === 'string' ? exception.body.message : '';
      return {
        status,
        message: SAFE_AUTH_MESSAGES.has(own) ? own : (STATUS_CODES[status] ?? 'Error'),
      };
    }
    if (this.isHttpError(exception)) {
      return { status: exception.statusCode, message: this.getHttpErrorMessage(exception) };
    }
    this.log.error(`Unhandled ${describeError(exception)}`);
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }
}
