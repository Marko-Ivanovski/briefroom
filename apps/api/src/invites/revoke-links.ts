import { inviteLinks, joinRequests, scoped, scopedUpdate, type Db } from '@briefroom/db';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Scope } from '../access/scope.ts';

type Tx = Pick<Db, 'update'>;

/**
 * Revokes the links matching `where` and declines their pending join requests (R103), so a leaked
 * link cannot leave an approvable request behind. Run it inside the caller's transaction.
 */
export async function revokeLinks(tx: Tx, scope: Scope, where: SQL | undefined) {
  const revoked = await tx
    .update(inviteLinks)
    .set(scopedUpdate(scope, { revokedAt: new Date() }))
    .where(and(scoped(scope, inviteLinks), isNull(inviteLinks.revokedAt), where))
    .returning();
  await declinePending(
    tx,
    scope,
    revoked.map((l) => l.id),
  );
  return revoked;
}

async function declinePending(tx: Tx, scope: Scope, inviteIds: string[]) {
  if (inviteIds.length === 0) return;
  await tx
    .update(joinRequests)
    .set(scopedUpdate(scope, { status: 'declined' as const }))
    .where(
      and(
        scoped(scope, joinRequests),
        eq(joinRequests.status, 'pending'),
        inArray(joinRequests.inviteId, inviteIds),
      ),
    );
}
