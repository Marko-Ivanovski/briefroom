import {
  CurrentScope,
  MODULE_STATE,
  ModuleController,
  type ModuleState,
  type Scope,
} from '@briefroom/module-kit';
import { Get, Inject } from '@nestjs/common';

@ModuleController('testkit', 'greeting')
export class GreetingController {
  constructor(@Inject(MODULE_STATE) private readonly state: ModuleState) {}

  @Get()
  greeting(@CurrentScope() scope: Scope): Promise<{ greeting: string }> {
    return this.state.settings<{ greeting: string }>(scope.workspaceId, 'testkit');
  }
}
