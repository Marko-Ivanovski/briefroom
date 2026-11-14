import { applyDecorators, Controller, UseGuards } from '@nestjs/common';
import { moduleEnabledGuard } from './module-enabled.guard.ts';

/**
 * Mounts a controller under the module's own prefix inside a workspace. The path carries
 * `:workspaceId`, so the global RequestGuard checks the session and membership before any module
 * handler runs.
 */
export const ModuleController = (moduleId: string, path = ''): ClassDecorator => {
  const suffix = path.replace(/^\/+|\/+$/g, '');
  return applyDecorators(
    Controller(`v1/workspaces/:workspaceId/m/${moduleId}${suffix ? `/${suffix}` : ''}`),
    UseGuards(moduleEnabledGuard(moduleId)),
  ) as ClassDecorator;
};
