import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpTokenGuard } from '../src/mcp/mcp-token.guard.ts';
import { createTestApp, type TestApp } from './helpers.ts';

/**
 * Routes under /api/v1 that are deliberately not inside a workspace. Everything else must carry
 * :workspaceId so the global WorkspaceScopeGuard checks membership before any handler runs.
 */
const OUTSIDE_A_WORKSPACE: ReadonlySet<string> = new Set([
  'GET /api/v1/me',
  'GET /api/v1/workspaces',
  'POST /api/v1/workspaces',
  // Personal to the signed-in user on this install, not workspace content.
  'GET /api/v1/bookmarks',
  'POST /api/v1/bookmarks',
  'DELETE /api/v1/bookmarks/:id',
  'GET /api/v1/setup',
  'POST /api/v1/setup',
  'GET /api/v1/setup/modules',
  'POST /api/v1/reset/:token',
  // Not inside a workspace because the caller has no account yet. Its anonymity is pinned separately in ANONYMOUS_ROUTES.
  'GET /api/v1/join/:token',
  // Anonymous like the lookup: the caller has no account yet and this creates it.
  'POST /api/v1/join/:token/sign-up',
  // Needs a session but names no workspace: the invite token decides which workspace is joined.
  'POST /api/v1/join/:token/accept',
  // The CLI has no account session yet: start and poll are public, and approve needs a session but the
  // login code, not a URL, names the workspace through the body.
  'POST /api/v1/cli-login',
  'POST /api/v1/cli-login/poll',
  'POST /api/v1/cli-login/approve',
  // Authenticated by the caller's own Bearer token, which it deletes. Never by a session.
  'DELETE /api/v1/tokens/self',
]);

/** Routes that skip the session check. Adding a public endpoint must be a deliberate edit here. */
const ANONYMOUS_ROUTES: readonly string[] = [
  'GET /api/health',
  'GET /api/version',
  'GET /api/v1/setup',
  'POST /api/v1/setup',
  'GET /api/v1/setup/modules',
  'POST /api/v1/reset/:token',
  'GET /api/v1/join/:token',
  'POST /api/v1/join/:token/sign-up',
  // Public: the CLI has no session yet. The poll token authenticates the poll, and the code alone cannot approve.
  'POST /api/v1/cli-login',
  'POST /api/v1/cli-login/poll',
  // Skips the session guard on purpose: only the caller's own Bearer brf_ token is accepted, and it deletes just that token.
  'DELETE /api/v1/tokens/self',
  // Skips the session guard on purpose (R146): only a Bearer brf_ token is accepted, checked by McpTokenGuard.
  'ALL /mcp',
];

const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

const asArray = (p: unknown): string[] =>
  Array.isArray(p) ? p : [p === undefined ? '' : String(p)];
const join = (...parts: string[]) =>
  '/' +
  parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function registeredRoutes(t: TestApp, onlyAnonymous = false): string[] {
  const routes: string[] = [];
  for (const mod of t.app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctor = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!ctor) continue;
      const base = asArray(Reflect.getMetadata(PATH_METADATA, ctor));
      for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
        const handler = (ctor.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        // Same lookup as the package's AuthGuard: handler metadata first, then the class.
        const isPublic =
          Reflect.getMetadata('PUBLIC', handler) ?? Reflect.getMetadata('PUBLIC', ctor);
        if (onlyAnonymous && !isPublic) continue;
        for (const b of base) {
          for (const p of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
            routes.push(
              `${REQUEST_METHODS[method as number]} ${join(b === 'mcp' ? '' : 'api', b, p)}`,
            );
          }
        }
      }
    }
  }
  return routes;
}

describe('route table', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('finds the routes it is meant to police', () => {
    const routes = registeredRoutes(t);
    expect(routes).toContain('GET /api/v1/me');
    expect(routes).toContain('POST /api/v1/workspaces/:workspaceId/leave');
    expect(routes).toContain('GET /api/v1/workspaces/:workspaceId/m/testkit/notes');
    expect(routes).toContain('GET /api/v1/workspaces/:workspaceId/history/:table/:recordId');
    expect(routes).toContain('GET /api/v1/workspaces/:workspaceId/files/:fileId');
    expect(routes).toContain('POST /api/v1/workspaces/:workspaceId/m/testkit/files');
  });

  it('keeps every /api/v1 route inside a workspace unless it is on the allowlist', () => {
    const offenders = registeredRoutes(t).filter(
      (route) =>
        route.split(' ')[1]!.startsWith('/api/v1/') &&
        !route.includes(':workspaceId') &&
        !OUTSIDE_A_WORKSPACE.has(route),
    );
    expect(
      offenders,
      'Workspace content must live under /v1/workspaces/:workspaceId/ so the scope guard checks membership. ' +
        'Move the route there, or add it to OUTSIDE_A_WORKSPACE with a reason if it is truly install-wide.',
    ).toEqual([]);
  });

  it('exposes exactly the intended anonymous routes', () => {
    expect(
      registeredRoutes(t, true).sort(),
      'A new public endpoint needs a deliberate edit to ANONYMOUS_ROUTES.',
    ).toEqual([...ANONYMOUS_ROUTES].sort());
  });

  it('puts the token guard on every /mcp route', () => {
    const controller = [...t.app.get(ModulesContainer, { strict: false }).values()]
      .flatMap((m) => [...m.controllers.values()])
      .map((w) => w.metatype as (abstract new (...args: never[]) => object) | null)
      .find((c) => c && Reflect.getMetadata(PATH_METADATA, c) === 'mcp');
    expect(controller).toBeDefined();
    expect(Reflect.getMetadata('__guards__', controller!)).toContain(McpTokenGuard);
  });

  it('knows no stale allowlist entries', () => {
    const routes = new Set(registeredRoutes(t));
    for (const allowed of OUTSIDE_A_WORKSPACE) expect(routes, allowed).toContain(allowed);
  });
});
