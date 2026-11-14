import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AuthModule } from './auth/auth.module.ts';
import { EnvModule } from './config/env.module.ts';
import type { Env } from './config/env.ts';
import { DatabaseModule } from './database/database.module.ts';
import { InstallModule } from './install/install.module.ts';
import { SystemController } from './system/system.controller.ts';
import { WorkspacesModule } from './workspaces/workspaces.module.ts';

@Module({})
export class AppModule {
  // extraControllers exists for tests that need probe routes; production passes none.
  static register(env: Env, extraControllers: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        DatabaseModule,
        InstallModule,
        AuthModule,
        WorkspacesModule,
        ServeStaticModule.forRoot({
          rootPath: env.webDir,
          exclude: ['/api/{*path}', '/mcp', '/mcp/{*path}', '/.well-known/{*path}'],
        }),
      ],
      controllers: [SystemController, ...extraControllers],
    };
  }
}
