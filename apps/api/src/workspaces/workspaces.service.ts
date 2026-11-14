import { Role, type WorkspaceSummary } from '@briefroom/contracts';
import { authSchema, type Db } from '@briefroom/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { AUTH } from '../auth/auth.module.ts';
import type { Auth } from '../auth/auth.ts';
import { DB } from '../database/database.module.ts';
import { InstallService } from '../install/install.service.ts';
import { WorkspaceModulesService } from '../module-registry/workspace-modules.service.ts';
import { workspaceSlug } from './workspace-slug.ts';

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly installs: InstallService,
    private readonly modules: WorkspaceModulesService,
  ) {}

  async listFor(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: authSchema.organization.id,
        name: authSchema.organization.name,
        role: authSchema.member.role,
      })
      .from(authSchema.member)
      .innerJoin(
        authSchema.organization,
        eq(authSchema.member.organizationId, authSchema.organization.id),
      )
      .where(eq(authSchema.member.userId, userId))
      .orderBy(asc(authSchema.organization.createdAt));
    return rows.map((r) => ({ id: r.id, name: r.name, role: Role.parse(r.role) }));
  }

  // Always through Better Auth's server API: its beforeCreateOrganization hook is the install-owner
  // rule, so organizations are never inserted directly.
  async create(userId: string, name: string, modules?: string[]): Promise<WorkspaceSummary> {
    if (!(await this.installs.isInstallOwner(userId))) {
      throw new ForbiddenException('Only the install owner can create workspaces');
    }
    const starting = this.modules.validateStarting(modules);
    const org = await this.auth.api.createOrganization({
      body: { name, slug: workspaceSlug(name), userId },
    });
    try {
      await this.modules.enableStarting(org.id, { userId, via: 'web' }, starting);
    } catch (err) {
      // Best effort: a retry must not find a module-less duplicate. Cascades remove the rest.
      await this.db
        .delete(authSchema.organization)
        .where(eq(authSchema.organization.id, org.id))
        .catch(() => undefined);
      throw err;
    }
    return { id: org.id, name: org.name, role: 'owner' };
  }
}
