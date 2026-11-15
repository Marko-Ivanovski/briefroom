import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AccessModule } from './access/access.module.ts';
import { AuthModule } from './auth/auth.module.ts';
import { EnvModule } from './config/env.module.ts';
import type { Env } from './config/env.ts';
import { DatabaseModule } from './database/database.module.ts';
import { SafeExceptionFilter } from './errors/safe-exception.filter.ts';
import { EventsModule } from './events/events.module.ts';
import { FilesModule } from './files/files.module.ts';
import { HistoryModule } from './history/history.module.ts';
import { InstallModule } from './install/install.module.ts';
import { InvitesModule } from './invites/invites.module.ts';
import { JobsModule } from './jobs/jobs.module.ts';
import { BriefroomMcpModule } from './mcp/mcp.module.ts';
import { ModuleRegistryModule } from './module-registry/module-registry.module.ts';
import { REGISTERED_MODULES } from './module-registry/registered-modules.ts';
import { ProjectsModule } from './projects/projects.module.ts';
import { SystemController } from './system/system.controller.ts';
import { TokensModule } from './tokens/tokens.module.ts';
import { UsageModule } from './usage/usage.module.ts';
import { WorkspacesModule } from './workspaces/workspaces.module.ts';

@Module({})
export class AppModule {
  // extraControllers, extraImports and accessAtRoot exist for tests; production passes none.
  static register(
    env: Env,
    extraControllers: Type[] = [],
    extraImports: Type[] = [],
    accessAtRoot = true,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        DatabaseModule,
        InstallModule,
        ModuleRegistryModule,
        HistoryModule,
        UsageModule,
        FilesModule,
        JobsModule.register('app'),
        EventsModule.register('app'),
        AuthModule,
        ...(accessAtRoot ? [AccessModule] : []),
        WorkspacesModule,
        ProjectsModule,
        InvitesModule,
        TokensModule,
        BriefroomMcpModule,
        ...REGISTERED_MODULES.map((m) => m.nestModule),
        ...extraImports,
        ServeStaticModule.forRoot({
          rootPath: env.webDir,
          exclude: ['/api/{*path}', '/mcp', '/mcp/{*path}', '/.well-known/{*path}'],
        }),
      ],
      controllers: [SystemController, ...extraControllers],
      providers: [{ provide: APP_FILTER, useClass: SafeExceptionFilter }],
    };
  }
}
