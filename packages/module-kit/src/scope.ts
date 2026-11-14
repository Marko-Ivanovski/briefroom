import type { Role } from '@briefroom/contracts';
import type { Actor } from '@briefroom/db';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface Scope {
  userId: string;
  workspaceId: string;
  role: Role;
  visibleProjectIds: 'all' | string[];
  /** Keys look like `<moduleId>:<key>`. */
  permissions: ReadonlySet<string>;
  actor: Actor;
}

/** The injection token for the shared Drizzle client. */
export const DB = Symbol('DB');

export const CurrentScope = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const scope = context.switchToHttp().getRequest<{ scope?: Scope }>().scope;
  if (!scope) throw new Error('CurrentScope used on a route without WorkspaceScopeGuard');
  return scope;
});
