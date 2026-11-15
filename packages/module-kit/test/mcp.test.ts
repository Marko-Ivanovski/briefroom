import type { CallHandler, ExecutionContext, NestInterceptor, Type } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ModuleTool,
  TOOL_REFUSED,
  systemScope,
  toolScope,
  type ModuleState,
  type Scope,
} from '../src/index.ts';

class Tools {
  run(): string {
    return 'ran';
  }
  write(): string {
    return 'wrote';
  }
}
const define = (method: 'run' | 'write', permission?: string) =>
  ModuleTool('notes', {
    name: `notes_${method}`,
    description: 'x',
    inputSchema: z.object({}),
    ...(permission ? { permission } : {}),
  })(Tools.prototype, method, Object.getOwnPropertyDescriptor(Tools.prototype, method)!);
define('run');
define('write', 'write-things');

const state = (over: Partial<ModuleState>): ModuleState => ({
  isEnabled: async () => true,
  settings: async () => ({}) as never,
  displayName: () => 'Notes',
  ...over,
});

async function call(method: 'run' | 'write', st: ModuleState, scope: Scope | undefined) {
  const handler = Tools.prototype[method];
  const Interceptor = (
    Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as Type<NestInterceptor>[]
  )[0]!;
  const interceptor = new Interceptor(st as never);
  const context = {
    getHandler: () => handler,
    getArgByIndex: (i: number) => (i === 1 ? { request: { scope } } : undefined),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: vi.fn(() => of(handler())) };
  const result = await firstValueFrom(await interceptor.intercept(context, next));
  return { result, next };
}

const member = (permissions: string[] = []): Scope => ({
  ...systemScope('w'),
  role: 'member',
  permissions: new Set(permissions),
});

describe('@ModuleTool', () => {
  it('runs the tool when the module is on', async () => {
    const { result, next } = await call('run', state({}), member());
    expect(result).toBe('ran');
    expect(next.handle).toHaveBeenCalled();
  });

  it('answers the off text with the manifest name, and never runs the tool', async () => {
    const { result, next } = await call('run', state({ isEnabled: async () => false }), member());
    expect(result).toBe('The Notes module is off in this workspace.');
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('falls back to the module id when the state has no display name', async () => {
    const { result } = await call(
      'run',
      state({ isEnabled: async () => false, displayName: undefined }),
      member(),
    );
    expect(result).toBe('The notes module is off in this workspace.');
  });

  it('refuses when the lookup throws, without the error text', async () => {
    const { result, next } = await call(
      'run',
      state({
        isEnabled: async () => {
          throw new Error('secret-detail');
        },
      }),
      member(),
    );
    expect(result).toBe(TOOL_REFUSED);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('refuses when the call has no scope', async () => {
    const isEnabled = vi.fn(async () => true);
    const { result, next } = await call('run', state({ isEnabled }), undefined);
    expect(result).toBe(TOOL_REFUSED);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('refuses a write tool without the module permission, and runs it with it', async () => {
    const denied = await call('write', state({}), member());
    expect(denied.result).toContain('permission');
    expect(denied.next.handle).not.toHaveBeenCalled();
    const allowed = await call('write', state({}), member(['notes:write-things']));
    expect(allowed.result).toBe('wrote');
  });

  it('checks the off state before the permission', async () => {
    const { result } = await call('write', state({ isEnabled: async () => false }), member());
    expect(result).toBe('The Notes module is off in this workspace.');
  });

  it('toolScope throws without a scope', () => {
    expect(() => toolScope({})).toThrow();
    expect(toolScope({ request: { scope: member() } }).role).toBe('member');
  });
});
