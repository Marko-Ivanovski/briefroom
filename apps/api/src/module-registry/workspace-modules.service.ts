import type { ModuleDetail, ModuleSummary } from '@briefroom/contracts';
import { scopedInsert, scopedUpdate, workspaceModules, type Actor, type Db } from '@briefroom/db';
import type { ModuleState } from '@briefroom/module-kit';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from './module-registry.service.ts';
import { mergeSubmittedSettings, readSettings } from './module-settings.ts';

@Injectable()
export class WorkspaceModulesService implements ModuleState {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** A missing or disabled row means off. */
  async isEnabled(workspaceId: string, moduleId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ enabled: workspaceModules.enabled })
      .from(workspaceModules)
      .where(
        and(eq(workspaceModules.workspaceId, workspaceId), eq(workspaceModules.moduleId, moduleId)),
      );
    return row?.enabled === true;
  }

  async list(workspaceId: string): Promise<ModuleSummary[]> {
    const rows = await this.db
      .select({ moduleId: workspaceModules.moduleId, enabled: workspaceModules.enabled })
      .from(workspaceModules)
      .where(eq(workspaceModules.workspaceId, workspaceId));
    const on = new Set(rows.filter((r) => r.enabled).map((r) => r.moduleId));
    return this.registry.list().map(({ manifest: m }) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: on.has(m.id),
    }));
  }

  async detail(workspaceId: string, moduleId: string): Promise<ModuleDetail> {
    const registered = this.registry.get(moduleId);
    if (!registered) throw new NotFoundException('Module not found');
    const { manifest: m } = registered;
    const [enabled, settings] = await Promise.all([
      this.isEnabled(workspaceId, moduleId),
      this.settings<Record<string, unknown>>(workspaceId, moduleId),
    ]);
    return { id: m.id, name: m.name, description: m.description, enabled, settings };
  }

  private async storedSettings(workspaceId: string, moduleId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ settings: workspaceModules.settings })
      .from(workspaceModules)
      .where(
        and(eq(workspaceModules.workspaceId, workspaceId), eq(workspaceModules.moduleId, moduleId)),
      );
    return row?.settings;
  }

  /** Read field by field (R114), so defaults fill in and one bad stored field costs only itself. */
  async settings<T = Record<string, unknown>>(workspaceId: string, moduleId: string): Promise<T> {
    const schema = this.registry.get(moduleId)?.manifest.settings;
    if (!schema) return {} as T;
    return readSettings(schema, await this.storedSettings(workspaceId, moduleId)) as T;
  }

  async update(
    scope: Scope,
    moduleId: string,
    input: { enabled?: boolean; settings?: Record<string, unknown> },
  ): Promise<ModuleSummary> {
    const registered = this.registry.get(moduleId);
    if (!registered) throw new NotFoundException('Module not found');
    const { manifest } = registered;

    let settings: Record<string, unknown> | undefined;
    if (input.settings !== undefined) {
      if (!manifest.settings) throw new BadRequestException('This module has no settings');
      const stored = await this.storedSettings(scope.workspaceId, moduleId);
      const merged = mergeSubmittedSettings(manifest.settings, stored, input.settings);
      // Zod's own message can quote the rejected value, so the response says only that it failed.
      if (!merged.ok) throw new BadRequestException('The settings are not valid for this module');
      settings = merged.value;
    }

    const change = {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(settings ? { settings } : {}),
    };
    await this.db
      .insert(workspaceModules)
      .values(scopedInsert(scope, { moduleId, enabled: false, settings: {}, ...change }))
      .onConflictDoUpdate({
        target: [workspaceModules.workspaceId, workspaceModules.moduleId],
        set: scopedUpdate(scope, change),
      });
    const enabled = await this.isEnabled(scope.workspaceId, moduleId);
    return { id: manifest.id, name: manifest.name, description: manifest.description, enabled };
  }

  /** Rejects ids the registry does not know and drops duplicates. */
  validateStarting(ids: string[] | undefined): string[] {
    const unique = [...new Set(ids ?? [])];
    const unknown = unique.filter((id) => !this.registry.get(id));
    if (unknown.length > 0) throw new BadRequestException('Unknown module in the starting set');
    return unique;
  }

  async enableStarting(workspaceId: string, actor: Actor, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const scope = { workspaceId, actor };
    await this.db
      .insert(workspaceModules)
      .values(ids.map((moduleId) => scopedInsert(scope, { moduleId, enabled: true, settings: {} })))
      .onConflictDoNothing();
  }
}
