import {
  ConflictException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import type { Scope } from './scope.ts';

/** Implemented by the API and the worker. Provided globally, so module code never imports an app. */
export interface ModuleState {
  isEnabled(workspaceId: string, moduleId: string): Promise<boolean>;
  /** The workspace's settings for a module, parsed through its manifest schema with defaults filled in. */
  settings<T = Record<string, unknown>>(workspaceId: string, moduleId: string): Promise<T>;
  /** The module's display name from its manifest, for messages an agent or person reads. */
  displayName?(moduleId: string): string | undefined;
}

export const MODULE_STATE = Symbol('MODULE_STATE');

// One class per id, so the contract test can compare a controller's guard by identity.
const GUARDS = new Map<string, Type<CanActivate>>();

/**
 * Runs after the global RequestGuard, so `req.scope` already exists. One guard class per module id
 * keeps the id out of reflection and out of anything a request can influence.
 */
export function moduleEnabledGuard(moduleId: string): Type<CanActivate> {
  const existing = GUARDS.get(moduleId);
  if (existing) return existing;
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
  GUARDS.set(moduleId, ModuleEnabledGuard);
  return ModuleEnabledGuard;
}
