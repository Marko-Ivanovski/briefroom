import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
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

/**
 * Runs inside RequestGuard right after the session check, so the session is already on the request
 * and no controller can forget the membership and role checks.
 */
@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  constructor(
    private readonly access: AccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ScopedRequest>();
    const min = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) {
      // A role requirement with no workspace to check it against is a wiring bug: fail closed.
      if (min) throw new InternalServerErrorException('@RequireRole needs a :workspaceId route');
      return true;
    }

    const scope = await this.access.scopeFor(userFromRequest(req).id, workspaceId, 'web');
    if (!scope) throw new NotFoundException();
    if (min && !roleAtLeast(scope, min)) throw new ForbiddenException();

    req.scope = scope;
    return true;
  }
}

export { CurrentScope } from '@briefroom/module-kit';
