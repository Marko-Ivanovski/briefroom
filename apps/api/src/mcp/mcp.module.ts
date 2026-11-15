import { Module, UseGuards } from '@nestjs/common';
import { McpModule } from '@nestjs/mcp';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { ProjectsModule } from '../projects/projects.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { APP_VERSION } from '../system/app-version.ts';
import { TokensModule } from '../tokens/tokens.module.ts';
import { CoreTools, MCP_INSTRUCTIONS } from './core.tools.ts';
import { McpTokenGuard } from './mcp-token.guard.ts';

@Module({
  imports: [
    ProjectsModule,
    McpModule.forRoot({
      name: 'briefroom',
      version: APP_VERSION,
      path: 'mcp',
      instructions: MCP_INSTRUCTIONS,
      // AllowAnonymous takes /mcp out of the session guard (R146): only the token guard decides here.
      decorators: [AllowAnonymous(), UseGuards(McpTokenGuard)],
      imports: [TokensModule, RateLimitModule],
    }),
  ],
  providers: [CoreTools],
})
export class BriefroomMcpModule {}
