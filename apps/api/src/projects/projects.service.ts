import type {
  ProjectDetail,
  ProjectInput,
  ProjectPatch,
  ProjectSummary,
} from '@briefroom/contracts';
import {
  projectMembers,
  projectRemotes,
  projects,
  projectToolLinks,
  scoped,
  scopedProjects,
  scopedInsert,
  scopedUpdate,
  type Db,
  type Tx,
} from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RevocationService } from '../members/revocation.service.ts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { roleAtLeast, type Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { InvalidRemoteError, normalizeRemote, stripCredentials } from './remote.ts';
import { SettingsService } from './settings.service.ts';

export type Project = typeof projects.$inferSelect;

const PG_UNIQUE_VIOLATION = '23505';

// Drizzle wraps the driver error, so the pg code can sit on a nested `cause`.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

interface ToolLinkRow {
  label: string;
  url: string;
  position: number;
}

interface RemoteRow {
  original: string;
  normalized: string;
}

function toRemotes(remotes: readonly string[]): RemoteRow[] {
  let rows: RemoteRow[];
  try {
    rows = remotes.map((original) => ({
      original: stripCredentials(original),
      normalized: normalizeRemote(original),
    }));
  } catch (err) {
    if (err instanceof InvalidRemoteError) throw new BadRequestException(err.message);
    throw err;
  }
  if (new Set(rows.map((r) => r.normalized)).size < rows.length) {
    throw new BadRequestException({
      code: 'duplicate_remote_in_request',
      message: 'The same repo remote is listed more than once.',
    });
  }
  return rows;
}

function toSummary(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    summary: p.summary,
    status: p.status,
    ticketKey: p.ticketKey,
    isClientWork: p.isClientWork,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly revocation: RevocationService,
  ) {}

  async list(scope: Scope): Promise<ProjectSummary[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(scopedProjects(scope))
      .orderBy(asc(projects.name), asc(projects.id));
    return rows.map(toSummary);
  }

  async get(scope: Scope, projectId: string): Promise<ProjectDetail> {
    return this.detail(this.db, scope, await this.require(this.db, scope, projectId));
  }

  /** Null when no project holds the remote or the caller cannot see it. */
  async findByRemote(scope: Scope, remote: string): Promise<Project | null> {
    let normalized: string;
    try {
      normalized = normalizeRemote(remote);
    } catch (err) {
      if (err instanceof InvalidRemoteError) return null;
      throw err;
    }
    const [row] = await this.db
      .select({ project: projects })
      .from(projectRemotes)
      .innerJoin(projects, eq(projectRemotes.projectId, projects.id))
      .where(
        and(
          scoped(scope, projectRemotes),
          eq(projectRemotes.normalized, normalized),
          scopedProjects(scope),
        ),
      );
    return row?.project ?? null;
  }

  async create(scope: Scope, input: ProjectInput): Promise<ProjectDetail> {
    if (
      !roleAtLeast(scope, 'admin') &&
      !(await this.settings.get(scope)).membersCanCreateProjects
    ) {
      throw new ForbiddenException('Only admins can create projects in this workspace');
    }
    const remotes = toRemotes(input.repoRemotes);
    const created = await this.write(() =>
      this.db.transaction(async (tx) => {
        const { name, client, summary, status, ticketKey, isClientWork } = input;
        const [project] = await tx
          .insert(projects)
          .values(scopedInsert(scope, { name, client, summary, status, ticketKey, isClientWork }))
          .returning();
        const links = input.toolLinks.map((l, position) => ({ ...l, position }));
        await this.insertLists(tx, scope, project!.id, remotes, links);
        await tx
          .insert(projectMembers)
          .values(scopedInsert(scope, { projectId: project!.id, userId: scope.userId }));
        // The caller just created this project, so it is theirs to read even before access catches up.
        return this.detail(tx, { ...scope, visibleProjectIds: 'all' }, project!);
      }),
    );
    // R134: the creator joined the project, so a member's open streams reconnect with it in view.
    if (!roleAtLeast(scope, 'admin')) {
      await this.revocation.projectMemberAdded(scope.workspaceId, scope.userId);
    }
    return created;
  }

  async update(scope: Scope, projectId: string, patch: ProjectPatch): Promise<ProjectDetail> {
    const remotes = patch.repoRemotes && toRemotes(patch.repoRemotes);
    return this.write(() =>
      this.db.transaction(async (tx) => {
        // Serialises concurrent edits of one project so the list syncs never interleave.
        await this.require(tx, scope, projectId, true);
        const { name, client, summary, status, ticketKey, isClientWork, toolLinks } = patch;
        const fields = { name, client, summary, status, ticketKey, isClientWork };
        const [project] = await tx
          .update(projects)
          .set(scopedUpdate(scope, fields))
          .where(and(scopedProjects(scope), eq(projects.id, projectId)))
          .returning();
        // Before any list write: a project deleted since require() must give 404, not an FK error.
        if (!project) throw new NotFoundException('Project not found');
        if (remotes) await this.syncRemotes(tx, scope, projectId, remotes);
        if (toolLinks) await this.syncToolLinks(tx, scope, projectId, toolLinks);
        return this.detail(tx, scope, project);
      }),
    );
  }

  async remove(scope: Scope, projectId: string): Promise<void> {
    if (!z.uuid().safeParse(projectId).success) throw new NotFoundException('Project not found');
    const deleted = await this.db
      .delete(projects)
      .where(and(scopedProjects(scope), eq(projects.id, projectId)))
      .returning({ id: projects.id });
    if (deleted.length === 0) throw new NotFoundException('Project not found');
  }

  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'remote_already_registered',
          message: 'This repo remote is already registered in this workspace.',
        });
      }
      throw err;
    }
  }

  private async require(
    db: Db | Tx,
    scope: Scope,
    projectId: string,
    lock = false,
  ): Promise<Project> {
    if (!z.uuid().safeParse(projectId).success) throw new NotFoundException('Project not found');
    const query = db
      .select()
      .from(projects)
      .where(and(scopedProjects(scope), eq(projects.id, projectId)));
    const [project] = await (lock ? query.for('update') : query);
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  // Links are matched by url, as a multiset in order. A matched link keeps its id, so a label edit
  // or a reorder does not wipe the access checklist rows that cascade from it.
  private async syncToolLinks(
    tx: Tx,
    scope: Scope,
    projectId: string,
    links: ProjectInput['toolLinks'],
  ): Promise<void> {
    const existing = await tx
      .select({
        id: projectToolLinks.id,
        label: projectToolLinks.label,
        url: projectToolLinks.url,
        position: projectToolLinks.position,
      })
      .from(projectToolLinks)
      .where(and(scoped(scope, projectToolLinks), eq(projectToolLinks.projectId, projectId)))
      .orderBy(asc(projectToolLinks.position), asc(projectToolLinks.id));
    const unmatched = [...existing];
    const added: ToolLinkRow[] = [];
    for (const [position, link] of links.entries()) {
      const at = unmatched.findIndex((e) => e.url === link.url);
      if (at < 0) {
        added.push({ ...link, position });
        continue;
      }
      const [row] = unmatched.splice(at, 1);
      if (row && (row.label !== link.label || row.position !== position)) {
        await tx
          .update(projectToolLinks)
          .set(scopedUpdate(scope, { label: link.label, position }))
          .where(and(scoped(scope, projectToolLinks), eq(projectToolLinks.id, row.id)));
      }
    }
    if (unmatched.length > 0) {
      await tx.delete(projectToolLinks).where(
        and(
          scoped(scope, projectToolLinks),
          inArray(
            projectToolLinks.id,
            unmatched.map((e) => e.id),
          ),
        ),
      );
    }
    await this.insertLists(tx, scope, projectId, [], added);
  }

  private async syncRemotes(
    tx: Tx,
    scope: Scope,
    projectId: string,
    remotes: readonly RemoteRow[],
  ): Promise<void> {
    const existing = await tx
      .select({
        id: projectRemotes.id,
        original: projectRemotes.original,
        normalized: projectRemotes.normalized,
      })
      .from(projectRemotes)
      .where(and(scoped(scope, projectRemotes), eq(projectRemotes.projectId, projectId)));
    const unmatched = [...existing];
    const added: RemoteRow[] = [];
    for (const remote of remotes) {
      const at = unmatched.findIndex((e) => e.normalized === remote.normalized);
      if (at < 0) {
        added.push(remote);
        continue;
      }
      const [row] = unmatched.splice(at, 1);
      if (row && row.original !== remote.original) {
        await tx
          .update(projectRemotes)
          .set(scopedUpdate(scope, { original: remote.original }))
          .where(and(scoped(scope, projectRemotes), eq(projectRemotes.id, row.id)));
      }
    }
    if (unmatched.length > 0) {
      await tx.delete(projectRemotes).where(
        and(
          scoped(scope, projectRemotes),
          inArray(
            projectRemotes.id,
            unmatched.map((e) => e.id),
          ),
        ),
      );
    }
    await this.insertLists(tx, scope, projectId, added, []);
  }

  private async insertLists(
    tx: Tx,
    scope: Scope,
    projectId: string,
    remotes: readonly RemoteRow[],
    links: readonly ToolLinkRow[],
  ): Promise<void> {
    if (remotes.length > 0) {
      await tx
        .insert(projectRemotes)
        .values(remotes.map((r) => scopedInsert(scope, { projectId, ...r })));
    }
    if (links.length > 0) {
      await tx
        .insert(projectToolLinks)
        .values(links.map((l) => scopedInsert(scope, { projectId, ...l })));
    }
  }

  private async detail(db: Db | Tx, scope: Scope, project: Project): Promise<ProjectDetail> {
    const [remotes, links] = await Promise.all([
      db
        .select({ original: projectRemotes.original, normalized: projectRemotes.normalized })
        .from(projectRemotes)
        .where(and(scoped(scope, projectRemotes), eq(projectRemotes.projectId, project.id)))
        .orderBy(asc(projectRemotes.createdAt), asc(projectRemotes.normalized)),
      db
        .select({
          id: projectToolLinks.id,
          label: projectToolLinks.label,
          url: projectToolLinks.url,
        })
        .from(projectToolLinks)
        .where(and(scoped(scope, projectToolLinks), eq(projectToolLinks.projectId, project.id)))
        .orderBy(asc(projectToolLinks.position), asc(projectToolLinks.id)),
    ]);
    return { ...toSummary(project), repoRemotes: remotes, toolLinks: links };
  }
}
