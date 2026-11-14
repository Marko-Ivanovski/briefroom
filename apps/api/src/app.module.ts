import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AccessModule } from './access/access.module.ts';
import { AuthModule } from './auth/auth.module.ts';
import { EnvModule } from './config/env.module.ts';
import type { Env } from './config/env.ts';
import { DatabaseModule } from './database/database.module.ts';
import { SafeExceptionFilter } from './errors/safe-exception.filter.ts';
import { InstallModule } from './install/install.module.ts';
import { InvitesModule } from './invites/invites.module.ts';
import { ModuleRegistryModule } from './module-registry/module-registry.module.ts';
import { REGISTERED_MODULES } from './module-registry/registered-modules.ts';
import { ProjectsModule } from './projects/projects.module.ts';
import { SystemController } from './system/system.controller.ts';
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
        AuthModule,
        ...(accessAtRoot ? [AccessModule] : []),
        WorkspacesModule,
        ProjectsModule,
        InvitesModule,
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
