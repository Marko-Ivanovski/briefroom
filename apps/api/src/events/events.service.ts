import { projects, scopedProjects, type Db, type Tx } from '@briefroom/db';
import type { EventInput, EventPublisher, Scope } from '@briefroom/module-kit';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canViewProject } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from '../module-registry/module-registry.service.ts';

export const EVENTS_CHANNEL = 'briefroom_events';

/** Postgres caps a NOTIFY payload at 8000 bytes. Events are notifications, so the cap is lower (R123). */
export const MAX_EVENT_BYTES = 6144;

const EVENT_TYPE = /^(core|[a-z][a-z0-9-]{1,30})\.[a-z][a-z0-9_.-]*$/;

/** What travels through NOTIFY and what a stream sends as `data`. */
export interface WorkspaceEvent {
  workspaceId: string;
  projectId?: string;
  type: string;
  payload: unknown;
}

export class EventTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `The event is ${bytes} bytes, over the ${MAX_EVENT_BYTES} byte limit. Publish a small notification and let clients refetch the details.`,
    );
  }
}

/** Publishes through Postgres NOTIFY, so the API and the worker both can, and every API process hears it. */
@Injectable()
export class EventsService implements EventPublisher {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** The module-facing path. The workspace is `scope.workspaceId`, and the type must carry a module id. */
  async publish(scope: Scope, event: EventInput, tx?: Tx): Promise<void> {
    const prefix = this.checkType(event.type);
    if (prefix === 'core')
      throw new Error(`"${event.type}" is a core event: modules cannot publish it`);
    if (!this.registry.get(prefix)) throw new Error(`"${prefix}" is not a registered module`);
    if (event.projectId !== undefined) await this.requireProject(scope, event.projectId, tx);
    await this.send(
      {
        workspaceId: scope.workspaceId,
        ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
        type: event.type,
        payload: event.payload ?? null,
      },
      tx,
    );
  }

  // Even an all-projects scope must name a project of its own workspace, or an event could be
  // aimed at another workspace's project id.
  private async requireProject(scope: Scope, projectId: string, tx?: Tx): Promise<void> {
    const [row] =
      z.uuid().safeParse(projectId).success && canViewProject(scope, projectId)
        ? await (tx ?? this.db)
            .select({ id: projects.id })
            .from(projects)
            .where(and(scopedProjects(scope), eq(projects.id, projectId)))
        : [];
    if (!row) throw new Error('The event names a project this workspace scope cannot see');
  }

  /** The core's own path: only `core.*` types. */
  async publishCore(
    event: { workspaceId: string; projectId?: string; type: string; payload?: unknown },
    tx?: Tx,
  ): Promise<void> {
    if (this.checkType(event.type) !== 'core')
      throw new Error('The core publishes core.* events only');
    await this.send({ ...event, payload: event.payload ?? null }, tx);
  }

  private checkType(type: string): string {
    if (!EVENT_TYPE.test(type)) {
      throw new Error(`"${type}" is not an event type: use <moduleId>.<name>`);
    }
    return type.slice(0, type.indexOf('.'));
  }

  private async send(event: WorkspaceEvent, tx?: Tx): Promise<void> {
    const body = JSON.stringify(event);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_EVENT_BYTES) throw new EventTooLargeError(bytes);
    // pg_notify joins the caller's transaction, so a rollback emits nothing.
    await (tx ?? this.db).execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${body})`);
  }
}
