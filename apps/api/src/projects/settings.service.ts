import type { WorkspaceSettings } from '@briefroom/contracts';
import { scoped, scopedInsert, scopedUpdate, workspaceSettings, type Db } from '@briefroom/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** A workspace with no row uses the defaults. */
  async get(scope: Scope): Promise<WorkspaceSettings> {
    const [row] = await this.db
      .select({ membersCanCreateProjects: workspaceSettings.membersCanCreateProjects })
      .from(workspaceSettings)
      .where(scoped(scope, workspaceSettings));
    return { membersCanCreateProjects: row?.membersCanCreateProjects ?? false };
  }

  async update(scope: Scope, input: WorkspaceSettings): Promise<WorkspaceSettings> {
    const [row] = await this.db
      .insert(workspaceSettings)
      .values(scopedInsert(scope, input))
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: scopedUpdate(scope, input),
      })
      .returning({ membersCanCreateProjects: workspaceSettings.membersCanCreateProjects });
    return { membersCanCreateProjects: row!.membersCanCreateProjects };
  }
}
