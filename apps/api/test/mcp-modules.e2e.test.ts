import { scopedInsert, usageEvents } from '@briefroom/db';
import { ModuleTool, ToolRefusalsInterceptor } from '@briefroom/module-kit';
import { testkitNotes } from '@briefroom/module-testkit/schema';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ForbiddenException, Module, NotFoundException, UseInterceptors } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceModulesService } from '../src/module-registry/workspace-modules.service.ts';
import { createTestApp, makeInstallOwner, resetThrottle, type TestApp } from './helpers.ts';

const PASSWORD = 'correct horse battery';
const OFF = 'The Testkit module is off in this workspace.';

class RefusingTools {
  @ModuleTool('testkit', {
    name: 'testkit_fixture_missing',
    description: 'test fixture',
    inputSchema: z.object({}),
    readOnly: true,
  })
  missing(): string {
    throw new NotFoundException('Note not found');
  }

  @ModuleTool('testkit', {
    name: 'testkit_fixture_boom',
    description: 'test fixture',
    inputSchema: z.object({}),
    readOnly: true,
  })
  boom(): string {
    throw new Error('db exploded: secret-detail');
  }

  @ModuleTool('testkit', {
    name: 'testkit_fixture_write',
    description: 'test fixture',
    inputSchema: z.object({}),
    permission: 'write-notes',
  })
  write(): string {
    return 'wrote';
  }

  @ModuleTool('testkit', {
    name: 'testkit_fixture_forbidden',
    description: 'test fixture',
    inputSchema: z.object({}),
    readOnly: true,
  })
  forbidden(): string {
    throw new ForbiddenException('Not allowed here');
  }
}

@UseInterceptors(ToolRefusalsInterceptor)
class CoreStyleTools {
  @Tool({ name: 'fixture_core_missing', description: 'test fixture', inputSchema: z.object({}) })
  missing(): string {
    throw new NotFoundException('Project not found');
  }
}

@Module({ providers: [RefusingTools, CoreStyleTools] })
class RefusingModule {}

describe('module tools over MCP', () => {
  let t: TestApp;
  let base: string;
  let ws: string;
  let alpha: string;
  let beta: string;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(t.app.getHttpServer());
  const api = (p = '') => `/api/v1/workspaces/${ws}${p}`;
  const as = (who: string) => ({ cookie: cookies[who]! });
  const modules = () => t.app.get(WorkspaceModulesService);
  const actor = () => ({ userId: ids.owner!, via: 'web' }) as const;
  const setEnabled = (enabled: boolean) =>
    modules().update({ workspaceId: ws, actor: actor() } as never, 'testkit', { enabled });

  async function addUser(key: string, role?: 'admin' | 'member') {
    const email = `${key}@example.com`;
    const { user } = await t.auth.api.createUser({
      body: { email, password: PASSWORD, name: key },
    });
    ids[key] = user.id;
    const res = await t.auth.api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    cookies[key] = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    if (role) await t.auth.api.addMember({ body: { userId: user.id, role, organizationId: ws } });
  }

  const connect = async (who: string, agent = 'claude-code'): Promise<Client> => {
    const res = await http().post(api('/tokens')).set(as(who)).send({ name: 'agent' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${res.body.token}`, 'x-briefroom-agent': agent },
        },
      }),
    );
    return client;
  };

  const textOf = (res: { content: unknown }): string =>
    (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  const usage = () => t.db.db.select().from(usageEvents).where(eq(usageEvents.workspaceId, ws));
  const call = async (who: string, name: string, args: Record<string, unknown> = {}) => {
    const client = await connect(who);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
    }
  };

  const note = (text: string, projectId: string | null) =>
    t.db.db
      .insert(testkitNotes)
      .values(
        scopedInsert(
          { workspaceId: ws, actor: { userId: ids.owner!, via: 'mcp', agent: 'claude-code' } },
          { text, projectId },
        ),
      );

  beforeAll(async () => {
    t = await createTestApp({}, [], [RefusingModule]);
    await t.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(t.app.getHttpServer().address() as { port: number }).port}`;
    await addUser('owner');
    await makeInstallOwner(t, ids.owner!);
    ws = (
      await t.auth.api.createOrganization({
        body: { name: 'Acme', slug: 'acme', userId: ids.owner! },
      })
    ).id;
    await addUser('alice', 'member');
    const created = (name: string) =>
      http().post(api('/projects')).set(as('owner')).send({ name, client: 'Globex' });
    alpha = (await created('Alpha')).body.id;
    beta = (await created('Beta')).body.id;
    await http()
      .post(api(`/projects/${alpha}/members`))
      .set(as('owner'))
      .send({ userId: ids.alice });
    await note('workspace-level note', null);
    await note('alpha note', alpha);
    await note('beta note', beta);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    resetThrottle(t);
    vi.restoreAllMocks();
    await setEnabled(true);
    await t.db.db.delete(usageEvents).where(eq(usageEvents.workspaceId, ws));
  });

  it('lists the tool when the module is off, and answers the off text without logging usage', async () => {
    await setEnabled(false);
    const client = await connect('alice');
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('testkit_list_notes');
    const res = await client.callTool({ name: 'testkit_list_notes', arguments: {} });
    expect(textOf(res)).toBe(OFF);
    expect(res.isError).toBeFalsy();
    expect(await usage()).toEqual([]);
    await client.close();
  });

  it('returns only the notes the caller can see, each with its origin, framed as reference', async () => {
    const res = await call('alice', 'testkit_list_notes');
    const text = textOf(res);
    expect(text).toContain('workspace-level note');
    expect(text).toContain('alpha note');
    expect(text).not.toContain('beta note');
    expect(text.toLowerCase()).toContain('not instructions');
    const body = JSON.parse(text.slice(text.indexOf('{'))) as {
      notes: { projectId: string | null; text: string; origin: Record<string, string> }[];
    };
    const a = body.notes.find((n) => n.text === 'alpha note')!;
    expect(a.projectId).toBe(alpha);
    expect(a.origin).toMatchObject({ by: 'owner', via: 'mcp', agent: 'claude-code' });
    expect(a.origin.at).toBeTruthy();
  });

  it('narrows to one project and shows an invisible project as empty', async () => {
    const only = await call('alice', 'testkit_list_notes', { projectId: alpha });
    expect(textOf(only)).toContain('alpha note');
    expect(textOf(only)).not.toContain('workspace-level note');
    const hidden = await call('alice', 'testkit_list_notes', { projectId: beta });
    expect(textOf(hidden)).not.toContain('beta note');
  });

  it('lets the owner see every note', async () => {
    const text = textOf(await call('owner', 'testkit_list_notes'));
    expect(text).toContain('beta note');
  });

  it('logs the tool name only, with the caller and agent', async () => {
    await call('alice', 'testkit_list_notes');
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'testkit_list_notes',
      userId: ids.alice,
      agent: 'claude-code',
      itemId: null,
    });
    expect(JSON.stringify(rows)).not.toContain('alpha note');
  });

  it('refuses without running or leaking detail when the module lookup throws', async () => {
    vi.spyOn(modules(), 'isEnabled').mockRejectedValue(new Error('db exploded: secret-detail'));
    const res = await call('alice', 'testkit_list_notes');
    const text = textOf(res);
    expect(text).not.toContain('alpha note');
    expect(text).not.toContain('secret-detail');
    expect(text.length).toBeGreaterThan(0);
    expect(await usage()).toEqual([]);
  });

  it('turns an expected refusal into its own text, and hides an unexpected error', async () => {
    const missing = await call('alice', 'testkit_fixture_missing');
    expect(textOf(missing)).toBe('Note not found');
    const forbidden = await call('alice', 'testkit_fixture_forbidden');
    expect(textOf(forbidden)).toBe('Not allowed here');
    const boom = await call('alice', 'testkit_fixture_boom');
    expect(textOf(boom)).toBe('Internal server error');
    expect(textOf(boom)).not.toContain('secret-detail');
  });

  it('shares the refusal helper with tools outside a module', async () => {
    expect(textOf(await call('alice', 'fixture_core_missing'))).toBe('Project not found');
  });

  it('answers the off text before the handler runs for a tool that throws', async () => {
    await setEnabled(false);
    expect(textOf(await call('alice', 'testkit_fixture_missing'))).toBe(OFF);
  });

  it('gates a write tool on the module permission in the caller scope', async () => {
    const denied = await call('alice', 'testkit_fixture_write');
    expect(textOf(denied)).not.toBe('wrote');
    expect(textOf(denied)).toContain('permission');
    const owner = await call('owner', 'testkit_fixture_write');
    expect(textOf(owner)).toBe('wrote');
  });

  it('caps the list at 50 newest notes and says when it is truncated', async () => {
    await t.db.db.delete(testkitNotes);
    for (let i = 1; i <= 51; i++) await note(`bulk ${String(i).padStart(2, '0')}`, null);
    const text = textOf(await call('alice', 'testkit_list_notes'));
    expect(text.match(/"text": "bulk/g)).toHaveLength(50);
    expect(text).toContain('Showing 50 of more notes.');
    expect(text).toContain('bulk 51');
    expect(text).not.toContain('bulk 01');
    const few = textOf(await call('alice', 'testkit_list_notes', { limit: 2 }));
    expect(few.match(/"text": "bulk/g)).toHaveLength(2);
    expect(few).toContain('Showing 2 of more notes.');
    await t.db.db.delete(testkitNotes);
    await note('only one', null);
    expect(textOf(await call('alice', 'testkit_list_notes'))).not.toContain('Showing');
  });
});
