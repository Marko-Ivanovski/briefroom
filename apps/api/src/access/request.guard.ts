import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { WorkspaceScopeGuard } from './workspace-scope.guard.ts';

/**
 * The single global guard. The session check and the workspace checks run in one place, so their
 * order never depends on where a module is imported.
 */
@Injectable()
export class RequestGuard implements CanActivate {
  constructor(
    private readonly session: AuthGuard,
    private readonly scope: WorkspaceScopeGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A tool call runs the global guards again, but its HTTP request already passed McpTokenGuard
    // and carries the scope. There is no session or workspace param to check here.
    if (context.getType<string>() === 'mcp') return true;
    if (!(await this.session.canActivate(context))) return false;
    return this.scope.canActivate(context);
  }
}
