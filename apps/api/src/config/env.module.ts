import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ENV, type Env } from './env.ts';

@Global()
@Module({})
export class EnvModule {
  static register(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
