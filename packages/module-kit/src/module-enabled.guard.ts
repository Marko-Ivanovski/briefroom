import {
  ConflictException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import type { Scope } from './scope.ts';

/** Implemented by the API. Provided globally, so module code never imports the API. */
export interface ModuleState {
  isEnabled(workspaceId: string, moduleId: string): Promise<boolean>;
}

export const MODULE_STATE = Symbol('MODULE_STATE');

/**
 * Runs after the global RequestGuard, so `req.scope` already exists. One guard class per module id
 * keeps the id out of reflection and out of anything a request can influence.
 */
export function moduleEnabledGuard(moduleId: string): Type<CanActivate> {
  @Injectable()
  class ModuleEnabledGuard implements CanActivate {
    constructor(@Inject(MODULE_STATE) private readonly state: ModuleState) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const scope = context.switchToHttp().getRequest<{ scope?: Scope }>().scope;
      if (!scope) throw new Error('ModuleEnabledGuard used on a route without a workspace scope');
      if (await this.state.isEnabled(scope.workspaceId, moduleId)) return true;
      throw new ConflictException({
        code: 'module_off',
        moduleId,
        message: 'This module is switched off in this workspace',
      });
    }
  }
  return ModuleEnabledGuard;
}
