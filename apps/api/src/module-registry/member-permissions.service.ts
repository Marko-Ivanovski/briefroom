import type { MemberPermission, SetPermissionRequest } from '@briefroom/contracts';
import { authSchema, memberPermissions, scopedInsert, type Db } from '@briefroom/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';
import { ModuleRegistryService } from './module-registry.service.ts';

@Injectable()
export class MemberPermissionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** Every permission of every registered module, as `<moduleId>:<key>`. */
  allKeys(): string[] {
    return this.registry
      .list()
      .flatMap(({ manifest }) => manifest.permissions.map((p) => `${manifest.id}:${p.key}`));
  }

  /** The grants a member holds, limited to modules that are still registered. */
  async grantedKeys(workspaceId: string, userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ moduleId: memberPermissions.moduleId, key: memberPermissions.key })
      .from(memberPermissions)
      .where(
        and(eq(memberPermissions.workspaceId, workspaceId), eq(memberPermissions.userId, userId)),
      );
    const registered = new Set(this.allKeys());
    return new Set(rows.map((r) => `${r.moduleId}:${r.key}`).filter((k) => registered.has(k)));
  }

  async view(scope: Scope, userId: string): Promise<MemberPermission[]> {
    const [target] = await this.db
      .select({ role: authSchema.member.role })
      .from(authSchema.member)
      .where(
        and(
          eq(authSchema.member.organizationId, scope.workspaceId),
          eq(authSchema.member.userId, userId),
        ),
      );
    if (!target) throw new NotFoundException('Member not found');
    const implied = target.role === 'owner' || target.role === 'admin';
    const granted = implied ? new Set<string>() : await this.grantedKeys(scope.workspaceId, userId);
    return this.registry.list().flatMap(({ manifest }) =>
      manifest.permissions.map((p) => ({
        moduleId: manifest.id,
        key: p.key,
        label: p.label,
        description: p.description,
        granted: implied || granted.has(`${manifest.id}:${p.key}`),
        implied,
      })),
    );
  }

  async set(scope: Scope, userId: string, input: SetPermissionRequest): Promise<MemberPermission> {
    const permission = this.registry
      .get(input.moduleId)
      ?.manifest.permissions.find((p) => p.key === input.key);
    if (!permission) throw new BadRequestException('Unknown module or permission');

    await this.db.transaction(async (tx) => {
      // The share lock on the member row queues this write behind a removal in flight, which
      // locks the same row and deletes the member's permissions, so none can outlive membership.
      // Both rows are share-locked in one statement in user_id order, as revoke() locks them, and
      // the caller's role is read here so an admin demoted a moment ago is refused.
      const locked = await tx
        .select({ userId: authSchema.member.userId, role: authSchema.member.role })
        .from(authSchema.member)
        .where(
          and(
            eq(authSchema.member.organizationId, scope.workspaceId),
            inArray(authSchema.member.userId, [...new Set([userId, scope.userId])]),
          ),
        )
        .orderBy(asc(authSchema.member.userId))
        .for('share');
      const caller = locked.find((m) => m.userId === scope.userId);
      if (caller?.role !== 'owner' && caller?.role !== 'admin') throw new ForbiddenException();
      const target = locked.find((m) => m.userId === userId);
      if (!target) throw new NotFoundException('Member not found');
      if (target.role === 'owner' || target.role === 'admin') {
        throw new ConflictException({
          code: 'implied_by_role',
          message: 'Owners and admins have every module permission.',
        });
      }
      if (input.granted) {
        await tx
          .insert(memberPermissions)
          .values(scopedInsert(scope, { userId, moduleId: input.moduleId, key: input.key }))
          .onConflictDoNothing();
      } else {
        await tx
          .delete(memberPermissions)
          .where(
            and(
              eq(memberPermissions.workspaceId, scope.workspaceId),
              eq(memberPermissions.userId, userId),
              eq(memberPermissions.moduleId, input.moduleId),
              eq(memberPermissions.key, input.key),
            ),
          );
      }
    });
    return {
      moduleId: input.moduleId,
      key: input.key,
      label: permission.label,
      description: permission.description,
      granted: input.granted,
      implied: false,
    };
  }
}
