import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { userFromRequest } from '../auth/current-user.decorator.ts';
import { AccessService } from './access.service.ts';
import { REQUIRED_ROLE } from './require-role.decorator.ts';
import { roleAtLeast, type Role, type Scope } from './scope.ts';

interface ScopedRequest {
  params: { workspaceId?: string };
  session?: { user?: { id: string; name: string; email: string } } | null;
  scope?: Scope;
}

/** Runs after the global auth guard, so the session is already on the request. */
@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  constructor(
    private readonly access: AccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) throw new NotFoundException();

    const scope = await this.access.scopeFor(userFromRequest(req).id, workspaceId, 'web');
    if (!scope) throw new NotFoundException();

    const min = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (min && !roleAtLeast(scope, min)) throw new ForbiddenException();

    req.scope = scope;
    return true;
  }
}

export const CurrentScope = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const scope = context.switchToHttp().getRequest<ScopedRequest>().scope;
  if (!scope) throw new Error('CurrentScope used on a route without WorkspaceScopeGuard');
  return scope;
});
