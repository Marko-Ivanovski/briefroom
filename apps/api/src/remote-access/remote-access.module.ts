import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { ENV, type Env } from '../config/env.ts';
import { RemoteAccessController } from './remote-access.controller.ts';
import { RemoteAccessService, supervisorStateDir } from './remote-access.service.ts';
import { spawnProcess, Supervisor, type SpawnChild } from './supervisor.ts';
import { TunnelState } from './tunnel-state.ts';

const SPAWN_CHILD = Symbol('SPAWN_CHILD');

/** Children get PATH and HOME only: the app's database url and secrets never reach them. */
function childEnv(stateDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? stateDir,
  };
}

@Global()
@Module({})
export class RemoteAccessModule {
  /** `spawnChild` is replaced in tests by a fake child process. */
  static register(spawnChild: SpawnChild = spawnProcess): DynamicModule {
    return {
      module: RemoteAccessModule,
      controllers: [RemoteAccessController],
      providers: [
        TunnelState,
        RemoteAccessService,
        { provide: SPAWN_CHILD, useValue: spawnChild },
        {
          provide: Supervisor,
          useFactory: (env: Env, spawn: SpawnChild) => {
            const stateDir = supervisorStateDir(env);
            return new Supervisor({
              spawn,
              port: env.port,
              stateDir,
              env: childEnv(stateDir),
              logger: new Logger('RemoteAccess'),
            });
          },
          inject: [ENV, SPAWN_CHILD],
        },
      ],
      exports: [TunnelState],
    };
  }
}
