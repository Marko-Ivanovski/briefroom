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
  scopedInsert,
  scopedUpdate,
  type Db,
} from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { roleAtLeast, type Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { InvalidRemoteError, normalizeRemote } from './remote.ts';
import { SettingsService } from './settings.service.ts';

export type Project = typeof projects.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const PG_UNIQUE_VIOLATION = '23505';

// Drizzle wraps the driver error, so the pg code can sit on a nested `cause`.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

interface RemoteRow {
  original: string;
  normalized: string;
}

function toRemotes(remotes: readonly string[]): RemoteRow[] {
  try {
    return remotes.map((original) => ({
      original: original.trim(),
      normalized: normalizeRemote(original),
    }));
  } catch (err) {
    if (err instanceof InvalidRemoteError) throw new BadRequestException(err.message);
    throw err;
  }
}

/** The project table has no project_id column, so scoped() alone checks only the workspace. */
function visibleProjects(scope: Scope): SQL {
  const inWorkspace = scoped(scope, projects);
  if (scope.visibleProjectIds === 'all') return inWorkspace;
  return and(
    inWorkspace,
    scope.visibleProjectIds.length > 0 ? inArray(projects.id, scope.visibleProjectIds) : sql`false`,
  )!;
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
  ) {}

  async list(scope: Scope): Promise<ProjectSummary[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(visibleProjects(scope))
      .orderBy(asc(projects.name), asc(projects.id));
    return rows.map(toSummary);
  }

  async get(scope: Scope, projectId: string): Promise<ProjectDetail> {
    return this.detail(this.db, scope, await this.require(this.db, scope, projectId));
  }

  /** Null when no project holds the remote or the caller cannot see it. */
  async findByRemote(scope: Scope, remote: string): Promise<Project | null> {
    const [row] = await this.db
      .select({ project: projects })
      .from(projectRemotes)
      .innerJoin(projects, eq(projectRemotes.projectId, projects.id))
      .where(
        and(
          scoped(scope, projectRemotes),
          eq(projectRemotes.normalized, normalizeRemote(remote)),
          visibleProjects(scope),
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
    return this.write(() =>
      this.db.transaction(async (tx) => {
        const { name, client, summary, status, ticketKey, isClientWork } = input;
        const [project] = await tx
          .insert(projects)
          .values(scopedInsert(scope, { name, client, summary, status, ticketKey, isClientWork }))
          .returning();
        await this.insertLists(tx, scope, project!.id, remotes, input.toolLinks);
        await tx
          .insert(projectMembers)
          .values(scopedInsert(scope, { projectId: project!.id, userId: scope.userId }));
        return this.detail(tx, scope, project!);
      }),
    );
  }

  async update(scope: Scope, projectId: string, patch: ProjectPatch): Promise<ProjectDetail> {
    const remotes = patch.repoRemotes && toRemotes(patch.repoRemotes);
    return this.write(() =>
      this.db.transaction(async (tx) => {
        await this.require(tx, scope, projectId);
        const { name, client, summary, status, ticketKey, isClientWork, toolLinks } = patch;
        const fields = { name, client, summary, status, ticketKey, isClientWork };
        const [project] = await tx
          .update(projects)
          .set(scopedUpdate(scope, fields))
          .where(and(visibleProjects(scope), eq(projects.id, projectId)))
          .returning();
        if (remotes) {
          await tx.delete(projectRemotes).where(eq(projectRemotes.projectId, projectId));
        }
        if (toolLinks) {
          await tx.delete(projectToolLinks).where(eq(projectToolLinks.projectId, projectId));
        }
        await this.insertLists(tx, scope, projectId, remotes ?? [], toolLinks ?? []);
        return this.detail(tx, scope, project!);
      }),
    );
  }

  async remove(scope: Scope, projectId: string): Promise<void> {
    const deleted = await this.db
      .delete(projects)
      .where(and(visibleProjects(scope), eq(projects.id, projectId)))
      .returning({ id: projects.id });
    if (deleted.length === 0) throw new NotFoundException('Project not found');
  }

  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A repo remote is already used by another project');
      }
      throw err;
    }
  }

  private async require(db: Db | Tx, scope: Scope, projectId: string): Promise<Project> {
    if (!z.uuid().safeParse(projectId).success) throw new NotFoundException('Project not found');
    const [project] = await db
      .select()
      .from(projects)
      .where(and(visibleProjects(scope), eq(projects.id, projectId)));
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  private async insertLists(
    tx: Tx,
    scope: Scope,
    projectId: string,
    remotes: readonly RemoteRow[],
    links: ProjectInput['toolLinks'],
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
        .orderBy(asc(projectToolLinks.createdAt), asc(projectToolLinks.id)),
    ]);
    return { ...toSummary(project), repoRemotes: remotes, toolLinks: links };
  }
}
