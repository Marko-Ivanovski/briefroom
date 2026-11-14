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
    if (!(await this.session.canActivate(context))) return false;
    return this.scope.canActivate(context);
  }
}
