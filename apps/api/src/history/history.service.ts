import type { HistoryEntry } from '@briefroom/contracts';
import {
  authSchema,
  projects,
  recordHistory,
  scopedInsert,
  scopedProjects,
  type Db,
  type Tx,
} from '@briefroom/db';
import type { HistoryInput, HistoryRecorder } from '@briefroom/module-kit';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';
import { diffRecord } from './diff.ts';

/** Core tables that keep a history. Empty until a core table needs one. */
export const CORE_HISTORY_TABLES: ReadonlySet<string> = new Set();

export interface HistorySource {
  /** The module that owns the table, or null for a core table. */
  moduleId: string | null;
}

@Injectable()
export class HistoryService implements HistoryRecorder {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** Who owns the table's history, or undefined when no module (or the core) opted the table in. */
  source(table: string): HistorySource | undefined {
    if (CORE_HISTORY_TABLES.has(table)) return { moduleId: null };
    const owner = this.registry
      .list()
      .find(({ manifest }) => manifest.historyTables?.includes(table));
    return owner ? { moduleId: owner.manifest.id } : undefined;
  }

  async record(tx: Tx, input: HistoryInput): Promise<void> {
    const { scope, table, recordId } = input;
    if (!this.source(table)) throw new Error(`History is not switched on for table "${table}"`);
    const changes = diffRecord(
      input.before as Record<string, unknown> | null,
      input.after as Record<string, unknown>,
    );
    if (Object.keys(changes).length === 0) return;
    await tx.insert(recordHistory).values(
      scopedInsert(scope, {
        projectId: input.projectId ?? null,
        tableName: table,
        recordId,
        changes,
        actorId: scope.actor.userId,
        via: scope.actor.via,
        agent: scope.actor.agent ?? null,
      }),
    );
  }

  /**
   * Newest first. Each entry is visible by its own project (R125): null is workspace-level, any
   * other project must be one the caller sees. No visible entry for a record that has history is a 404.
   */
  async entries(scope: Scope, table: string, recordId: string): Promise<HistoryEntry[]> {
    const ofRecord = and(
      eq(recordHistory.workspaceId, scope.workspaceId),
      eq(recordHistory.tableName, table),
      eq(recordHistory.recordId, recordId),
    );
    const visibleProjects = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(scopedProjects(scope));
    const rows = await this.db
      .select({
        id: recordHistory.id,
        actorId: recordHistory.actorId,
        actorName: authSchema.user.name,
        via: recordHistory.via,
        agent: recordHistory.agent,
        at: recordHistory.at,
        changes: recordHistory.changes,
      })
      .from(recordHistory)
      .leftJoin(authSchema.user, eq(authSchema.user.id, recordHistory.actorId))
      .where(
        and(
          ofRecord,
          or(isNull(recordHistory.projectId), inArray(recordHistory.projectId, visibleProjects)),
        ),
      )
      .orderBy(desc(recordHistory.at), desc(recordHistory.createdAt));

    if (rows.length === 0) {
      const [any] = await this.db
        .select({ id: recordHistory.id })
        .from(recordHistory)
        .where(ofRecord)
        .limit(1);
      if (any) throw new NotFoundException('Record not found');
    }
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorName: r.actorName,
      via: r.via,
      agent: r.agent,
      at: r.at.toISOString(),
      changes: r.changes,
    }));
  }
}
