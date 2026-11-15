import { Module, type OnModuleInit } from '@nestjs/common';
import { McpHttpService, McpModule } from '@nestjs/mcp';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { UseGuards } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.ts';
import { RateLimitModule } from '../rate-limit/rate-limit.ts';
import { APP_VERSION } from '../system/app-version.ts';
import { TokensModule } from '../tokens/tokens.module.ts';
import { CoreTools, MCP_INSTRUCTIONS } from './core.tools.ts';
import { McpRequestGuard } from './mcp-request.guard.ts';
import { longLivedStreamRequest, methodNotFoundBody } from './mcp-streams.ts';
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
      decorators: [AllowAnonymous(), UseGuards(McpTokenGuard, McpRequestGuard)],
      imports: [TokensModule, RateLimitModule],
    }),
  ],
  providers: [CoreTools],
})
export class BriefroomMcpModule implements OnModuleInit {
  constructor(private readonly http: McpHttpService) {}

  // @nestjs/mcp 0.0.4 has no switch for subscriptions/listen, and the SDK serves it before any tool
  // runs. Every request, from the route or from a direct call, passes this one seam first.
  onModuleInit(): void {
    const dispatch = this.http.fetch.bind(this.http);
    this.http.fetch = async (request, options) => {
      if (request.method === 'POST') {
        const body =
          options?.parsedBody ??
          (await request
            .clone()
            .json()
            .catch(() => undefined));
        const stream = longLivedStreamRequest(body);
        if (stream) return Response.json(methodNotFoundBody(stream.id), { status: 404 });
      }
      return dispatch(request, options);
    };
  }
}
