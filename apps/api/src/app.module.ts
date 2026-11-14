import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AuthModule } from './auth/auth.module.ts';
import { ENV, type Env } from './config/env.ts';
import { DatabaseModule } from './database/database.module.ts';
import { SystemController } from './system/system.controller.ts';

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        DatabaseModule,
        AuthModule,
        ServeStaticModule.forRoot({
          rootPath: env.webDir,
          exclude: ['/api/{*path}', '/mcp', '/mcp/{*path}', '/.well-known/{*path}'],
        }),
      ],
      controllers: [SystemController],
    };
  }
}

@Global()
@Module({})
class EnvModule {
  static register(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
