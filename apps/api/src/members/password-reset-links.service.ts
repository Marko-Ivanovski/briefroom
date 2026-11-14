import { createHash, randomBytes } from 'node:crypto';
import { authSchema, createdStamp, passwordResetLinks, type Actor, type Db } from '@briefroom/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ENV, type Env } from '../config/env.ts';
import { DB } from '../database/database.module.ts';

export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface IssuedLink {
  url: string;
  expiresAt: Date;
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues links only, so the host command can use it without the HTTP and auth stack. */
@Injectable()
export class PasswordResetLinks {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `workspaceId` is null for install-level links made by the host command. */
  async issue(userId: string, workspaceId: string | null, actor: Actor): Promise<IssuedLink> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS);
    await this.db.insert(passwordResetLinks).values({
      workspaceId,
      userId,
      tokenHash: hashResetToken(token),
      expiresAt,
      ...createdStamp(actor),
    });
    return { url: `${this.env.publicUrl}/reset/${token}`, expiresAt };
  }

  async userIdByEmail(email: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .where(eq(authSchema.user.email, email.trim().toLowerCase()));
    return row?.id ?? null;
  }
}
