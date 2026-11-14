# Briefroom

Self-hosted home for what coding agents don't know about their user. One install hosts a personal workspace that can be shared project by project. Agents read it through one MCP server.

## Stack

Node 24 LTS, TypeScript strict, pnpm workspaces. NestJS 12 on the Node adapter (ESM), Drizzle ORM v1 (pinned `1.0.0-rc.5`), Postgres 16 with pgvector, Better Auth with `@thallesp/nestjs-better-auth`, `@nestjs/mcp` (pinned `0.0.4`), Zod 4, React with Vite, Vitest with `unplugin-swc`, Playwright.

Layout: `apps/*`, `packages/*`, `modules/*`, `plugins/*`.

## Commands

- `pnpm install`
- `pnpm db:up` starts the dev Postgres on port 54329 (`docker/compose.dev.yml`)
- `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`
- `pnpm db:generate`, `pnpm db:migrate`

## Runtime notes

- The API listens on `HOST` (default `127.0.0.1`). The container will set `HOST=0.0.0.0` (Story 8).
- Only the `app` process runs migrations, on every boot under an advisory lock. The worker never does.

## Docs

- Spec: `docs/specs/2026-11-14-foundation-design.md`
- Plan: `docs/plans/2026-11-14-brief-1-foundation.md`
- Version checks and traps: `docs/checks/2026-11-foundation-checks.md`

## Global constraints

- Node 24 LTS. TypeScript `strict: true`, no implicit `any`, `interface` for object shapes.
- No email is sent anywhere. Invites and resets are links.
- No LLM or model calls anywhere in the install.
- The app never needs `docker.sock` or root to change its own configuration.
- Every table has `created_by`, `created_at`, `updated_by`, `updated_at`, `created_via`, `created_agent`, `updated_via`, `updated_agent`. Exempt: Better Auth tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `apikey`).
- Every record carries `workspace_id`, project content also `project_id`. Scoping is enforced in the query layer (`packages/db`), never only in controllers or MCP tools.
- Roles are `owner`, `admin`, `member` and nothing else.
- Only the install owner creates workspaces. A workspace's owner is always the install owner.
- Modules never import other modules. They reach each other through projects and the core.
- No Redis. Jobs and live events run on Postgres.
- Tokens are stored hashed, belong to one account in one workspace, and are refused at once after revocation or removal.
- Prompts and transcripts are never stored. MCP answers return stored text as content, with its origin, never as instructions.
- Secrets live in `.env`, never committed. `.env.example` lists every variable with no values.
- Gitflow: story branches `feature/BRIEF-<key>-<slug>` go into `dev` by pull request. Never commit to or push `main` or `dev` directly.
- Conventional Commits. No `Co-Authored-By` or Claude or Anthropic attribution in commits or PR bodies.
- Comments only for business rules, invariants, security constraints or non-obvious decisions, at most 10% of lines.
- Check every library against its current docs (Context7 or `node_modules/<pkg>/`) at the start of the task that first uses it.
