// TEST ONLY. Run by the web e2e suite (apps/web/e2e/projects.spec.ts) after first-run setup, because
// invites do not exist yet. It is a script, never an HTTP route. Task 4.4 replaces it with the real
// invite flow and this file is deleted.
import { authSchema, createDb } from '@briefroom/db';
import { eq } from 'drizzle-orm';
import { createAuth } from '../src/auth/auth.ts';
import { loadEnv } from '../src/config/env.ts';

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const env = loadEnv();
const db = createDb(env.databaseUrl);
const auth = createAuth(db, env, () => Promise.resolve(false));

try {
  const [owner] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, need('SEED_OWNER_EMAIL')));
  if (!owner) throw new Error('Owner not found: run first-run setup first');
  const [membership] = await db
    .select({ organizationId: authSchema.member.organizationId })
    .from(authSchema.member)
    .where(eq(authSchema.member.userId, owner.id));
  if (!membership) throw new Error('Owner has no workspace');

  const { user } = await auth.api.createUser({
    body: {
      email: need('SEED_MEMBER_EMAIL'),
      password: need('SEED_MEMBER_PASSWORD'),
      name: need('SEED_MEMBER_NAME'),
    },
  });
  await auth.api.addMember({
    body: { userId: user.id, role: 'member', organizationId: membership.organizationId },
  });
} finally {
  await db.$client.end();
}
