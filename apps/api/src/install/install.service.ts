import { AsyncLocalStorage } from 'node:async_hooks';
import { install, updatedStamp, type Db } from '@briefroom/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq, isNull, and, sql } from 'drizzle-orm';
import { DB } from '../database/database.module.ts';
import { generateSetupCode, hashSetupCode } from './setup-code.ts';

const SYSTEM = { userId: 'system', via: 'system' } as const;

export type InstallRow = typeof install.$inferSelect;

@Injectable()
export class InstallService {
  // Holds the id of the user being set up, so the owner check passes before owner_user_id is written.
  private readonly settingUp = new AsyncLocalStorage<string>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async getRow(): Promise<InstallRow> {
    await this.db
      .insert(install)
      .values({
        createdBy: 'system',
        createdVia: 'system',
        updatedBy: 'system',
        updatedVia: 'system',
      })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(install);
    if (!row) throw new Error('install row missing');
    return row;
  }

  async ensureInstall(): Promise<{ installId: string; setupCode: string | null }> {
    const row = await this.getRow();
    if (row.ownerUserId) return { installId: row.id, setupCode: null };
    const setupCode = generateSetupCode();
    await this.db
      .update(install)
      .set({
        setupCodeHash: hashSetupCode(setupCode),
        failedSetupAttempts: 0,
        ...updatedStamp(SYSTEM),
      })
      .where(and(eq(install.id, row.id), isNull(install.ownerUserId)));
    return { installId: row.id, setupCode };
  }

  async isInstallOwner(userId: string): Promise<boolean> {
    const [row] = await this.db.select({ owner: install.ownerUserId }).from(install);
    return row?.owner === userId;
  }

  async canCreateWorkspace(userId: string): Promise<boolean> {
    return this.settingUp.getStore() === userId || (await this.isInstallOwner(userId));
  }

  runAsSetupOf<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.settingUp.run(userId, fn);
  }

  async registerFailedAttempt(): Promise<void> {
    await this.db.update(install).set({
      failedSetupAttempts: sql`${install.failedSetupAttempts} + 1`,
      ...updatedStamp(SYSTEM),
    });
  }

  async completeSetup(ownerUserId: string): Promise<void> {
    await this.db
      .update(install)
      .set({
        ownerUserId,
        setupCodeHash: null,
        failedSetupAttempts: 0,
        ...updatedStamp({ userId: ownerUserId, via: 'web' }),
      })
      .where(isNull(install.ownerUserId));
  }
}
