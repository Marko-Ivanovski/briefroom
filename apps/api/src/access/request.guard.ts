import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { REQUIRED_ROLE } from './require-role.decorator.ts';
import { roleAtLeast, type Role, type Scope } from './scope.ts';
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
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() === 'mcp') return this.canCallTool(context);
    if (!(await this.session.canActivate(context))) return false;
    return this.scope.canActivate(context);
  }

  // A tool call has no session or :workspaceId. Its HTTP request passed McpTokenGuard, which put
  // the scope on it. A call that reaches a tool without that scope is refused, and @RequireRole
  // is checked against it exactly as WorkspaceScopeGuard does for HTTP.
  private canCallTool(context: ExecutionContext): boolean {
    const scope = context.getArgByIndex<{ request?: { scope?: Scope } } | undefined>(1)?.request
      ?.scope;
    if (!scope) return false;
    const min = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    return !min || roleAtLeast(scope, min);
  }
}
