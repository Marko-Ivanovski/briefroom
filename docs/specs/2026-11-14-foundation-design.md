# Briefroom foundation

Design doc, 2026-11-14. Written from the rebase session with Marko on 2026-11-14. It covers the infrastructure every module stands on. Each module (design library, knowledge, agent board) gets its own design session after this.

**Status:** approved by Marko on 2026-11-14.

**Release:** the foundation plus the main module (the design library) is v0.1, the first release. v1 is a long way off (Marko, 2026-11-14).

**Supersedes** parts of `2026-11-11-workspaces-and-connection-design.md`. That doc still holds for invite links, browser joining, bookmarks, password resets, connection modes and connecting agents, except where this doc says otherwise. "What this replaces" at the end lists every change.

Each choice is marked **Marko's** or **Claude's call**. Claude's calls are recommendations Marko can overturn while reading.

## What Briefroom is

Briefroom is a self-hosted home for what your coding agents don't know about you: your design taste, your rules and where your projects stand. You add to it while you work, and every agent reads it through one MCP server. The web app is where people browse, critique and curate.

The core idea (Marko's): **a personal workspace that you can let others join, to collaborate on the projects being done there.** You install Briefroom once. That install is the host. Inside it you own a workspace, switch on the modules you need, and invite people into the projects they should work on.

It is for developers who build with coding agents: solo developers and small teams. It is not for clients or non-developers (Marko's).

## Why the rebase

The 2026-11-10 plan had about 40 features across three modules. It was written for one developer who has no team yet. On 2026-11-14 Marko chose to build the infrastructure first and then add modules one at a time, each with its own design. This doc is that infrastructure.

## Goals

- One person installs Briefroom and has a working personal workspace in about ten minutes.
- It works fully alone. Sharing is something you switch on later, not a setup step.
- A teammate joins from a link in their browser, with no install.
- Access is decided per project, so each person sees only the work they're on.
- Every record says who made it, who last changed it and when.
- A module can be added to a workspace at any time without reinstalling.
- Members' agents connect with their own Claude subscription. Briefroom never holds a subscription token.

## Non-goals for v1

- Guest, viewer or client roles (Marko's, see "Access").
- Modules written by other people (Claude's call, see "Modules").
- Granting or syncing access in GitHub, Jira, Figma or other tools (Marko's).
- Design tool integrations such as Figma (Marko's).
- Sending email.
- A hosted version.
- Any built-in LLM call. Anything that needs a model runs in the member's own agent through MCP.

## Anti-goals

These would make it a failure even if it technically works:

- A solo user has to understand accounts, invites or networking before they can use it.
- One project's client work becomes visible to someone who isn't on that project.
- A record whose author or last editor can't be told.
- The core knows what a design, a note or a session is. Those belong to modules.
- Someone else's workspace lives on your computer, so deleting your install destroys their work.
- The app needs `docker.sock` or root to change its own configuration.
- Briefroom steers or messages agents.

## Concepts

| Term | Meaning |
|---|---|
| Install | One running Briefroom on a PC, home server or VPS. It is the host. Has a permanent install ID |
| Install owner | The person who set up the install. Manages it: remote access, backups, updates, password resets. The only account that can create workspaces on it |
| Account | Email and password on one install |
| Workspace | What people create and join. Holds projects, the workspace-wide module content (such as the design library) and the module switches |
| Project | A piece of work inside a workspace. Name, repos, members, tool links. Modules attach their project content to it |
| Module | A self-contained feature area: design library, knowledge, agent board. Switched on per workspace |
| Membership | An account's role in one workspace |
| Project membership | Whether a workspace member is on a project |

## Access

Researched on 2026-11-14 against Linear, Plane, Supabase and Vercel. All four keep small teams on a few broad roles. Read-only, guest and per-project roles exist for clients, compliance and large companies, and each product puts them on its top plans. Briefroom follows the small-team pattern.

### Creating workspaces

Marko, 2026-11-14: only the install owner creates workspaces on an install. If a friend joins Marko's workspace on Marko's PC, the friend can't create workspaces there, because deleting the install would delete them too. The friend creates their own workspaces on their own install, and reaches Marko's through the bookmark described in the 2026-11-11 spec.

- **The button.** The "New workspace" button only shows for the install owner.
- **Joining.** Every other account on an install exists only to join workspaces through invite links.
- **Transfer.** Workspace ownership can't be transferred to an account other than the install owner, for the same reason (Claude's call).

### Workspace roles

Claude's call, from the research. Replaces the roles table in the 2026-11-11 spec.

| Role | Can |
|---|---|
| Owner | Everything, including deleting the workspace. One per workspace, and always the install owner |
| Admin | Members, invites, roles, module switches, workspace settings. Sees every project |
| Member | Uses the modules. Sees the workspace-wide content and only the projects they are on |

No Guest or Viewer role (Marko's).

### Project access

Marko: access is decided per project, with toggles.

- A member joins the workspace with no projects. An Owner or Admin adds them to the projects they should see (Claude's call on who can add).
- Being on a project means you can contribute to it. There is no read-only project role (Claude's call, following Marko's "no guest roles").
- Owner and Admins see every project without being added, as in Plane.
- Creating projects: Owner and Admins by default. A workspace setting lets Members create projects too (Claude's call). A project's creator is on it automatically.
- Removing someone from a project ends their access to it at once, in the app and through MCP. Members can also leave a project themselves (Claude's call).

### Module permissions

Claude's call. A module can declare extra per-member toggles, and the members page shows them next to the project toggles. The design module will declare "can edit library". Owner and Admins always have every module permission. The core stores and checks toggles but never knows what they mean.

### Access in other tools

Marko: GitHub, Jira and other tools keep their own access, and Briefroom doesn't manage it.

Claude's call on what Briefroom does instead:

- **Tool links.** A project lists the tools it uses: repo, Jira board, docs and anything else, as links.
- **Access checklist.** Adding someone to a project shows that list as a checklist ("invite them to the repo, the Jira board"). The admin ticks items off by hand.
- **Removal checklist.** Removing someone shows the same list again, so nobody keeps repo access after leaving a client project.

No integrations or API calls to those tools.

## Who and when

Marko: who added and updated a record, and when, is a must.

- **Audit columns.** Every table in the core and in every module has `created_by`, `created_at`, `updated_by` and `updated_at`. This is a rule of the module contract, checked in tests, not a per-module choice.
- **Agent origin.** When an agent writes through MCP, the record also stores the agent and the person it acted for, shown as "Claude Code for Marko" (Claude's call).
- **History service.** The core keeps a change history any module can switch on per table: who changed which fields, when and through what (web, MCP, CLI) (Claude's call). The design library will use it for its entries.
- **Content stays content.** MCP answers include the origin of each record. Stored text is returned as content, never as instructions to the agent.

## Modules

### What a module is

Claude's call. A module is one folder in the repo that holds both halves:

- **Server:** a NestJS module with its controllers under `/api/v1/<module>`, its services, its MCP tools and its background jobs.
- **Schema:** its Drizzle tables.
- **Frontend:** its pages, navigation entries and settings panel, loaded only when the module is on.
- **Manifest:** the module's ID, name and version, plus what it declares:
  - its workspace-wide content and its project-level content
  - its permission toggles
  - its settings
  - its part of the workspace export

### What the core gives modules

- Accounts, workspaces, roles and project access, with one guard that answers "can this member do this here?"
- Projects, and the link from a repo remote to a project.
- The audit columns and the history service.
- A file store with thumbnails and reduced sizes (sharp), served only after an access check.
- Background jobs on Postgres.
- A live event stream per workspace over server-sent events, which the frontend and the agent board use.
- The MCP server. A module registers its tools with it.
- A usage log of every MCP read: which item, which project, which agent.
- Workspace export and import, which each module adds its part to.

Modules talk to each other only through projects and the core. A module never imports another module.

### Switching modules on

- Modules switch on per workspace, not per install (Claude's call). Every module ships in the same install, so adding one later is a toggle.
- While setting up a workspace you pick a starting set (Marko wanted to choose modules during setup). Owner and Admins change it later in Settings.
- When a module is off, its pages and navigation disappear, its API answers that the module is off, and its MCP tools either disappear from the tool list or say the module is off (see "Checks before building").
- Switching a module off hides its data and doesn't delete it.

### Who writes modules

First-party only in v1 (Claude's call, Marko didn't object). The contract is strict enough that a loader for outside modules could come later without a rewrite. Outside modules would need a versioned module API and sandboxing, which roughly doubles the foundation.

### The modules after the foundation

Each gets its own design session. In order (from C-08, Marko can reorder):

1. Design library
2. Knowledge
3. Agent board

The foundation proves the contract with a small internal test module that never ships.

## What the foundation must support for the design library

The design library gets its own design session. These decisions from 2026-11-14 shape the foundation, so they're recorded here:

- **Workspace-wide library.** Every workspace member can see the library. Only members with "can edit library" add to it or edit it (Marko's).
- **Project mockups.** People on a project pick designs from the library into the project's brief and make mockups against it. Only people on that project see the mockups (Marko's). Mockups are screenshots and images, with no Figma or other design tool (Marko's).
- **Publishing.** When a design is done, the people who made it can publish it to the library, where it appears as a design that came out of the references (Marko's).
- **Who can publish:** anyone on the project, without needing "can edit library" (Claude's call, reading Marko's "if the people who created it want to"). Library editors can still edit or remove it afterwards.
- **What gets published:** the final version with its screenshots and critique. The full version history stays in the project (Claude's call).
- **Lineage:** the published entry links back to its project and to the references in its brief. Any reference shows the finished designs that came out of it (Claude's call).
- **Client work guard:** projects can be marked as client work. Publishing from one asks for confirmation, and you can publish the critique without the screenshots (Claude's call).

What the foundation needs from this: workspace-level and project-level content, module permission toggles, the client-work flag on projects, and cross-level links that keep their access checks.

## Install and run

From the 2026-11-11 spec, with changes marked.

1. `npx briefroom init` asks a few questions, writes `.env` and downloads the Compose file. It no longer asks for a connection mode up front. The install starts solo (change, see "Reaching the install").
2. `docker compose up -d` starts three containers: `app` (the API, MCP and the built frontend), `worker` (same image, different command) and `db` (Postgres with pgvector).
3. The terminal and the Docker logs show the address and a one-time setup code (Claude's call, kept). The code stops someone else on the network from claiming the install first.
4. Open the address, enter the code and create the first account. It becomes the install owner.
5. Briefroom creates a personal workspace for that account and asks which modules to start with (Claude's call on creating it automatically, since the personal workspace is the core idea).

`git clone` plus `cp .env.example .env` stays documented as the manual path.

## Reaching the install

Marko: by default it's solo, meaning this computer or the local network. Funnels and tunnels are a setting.

- **Default.** The install listens on this computer. A switch in Settings opens it to the local network, behind Caddy with a local certificate as in the 2026-11-11 spec.
- **Remote access is a setting** (change from D-026, which said terminal only). The `app` image includes `cloudflared` and Tailscale. The app starts and stops them as child processes inside its own container, so it never needs Docker access (Claude's call, unverified, see "Checks before building").
- **Options in Settings:** Tailscale (private), Tailscale Funnel, Cloudflare Tunnel on your own domain. The limits listed in the 2026-11-11 spec still apply.
- **Not in Settings:** "own domain with Let's Encrypt" and "own reverse proxy" need ports and DNS, so they stay terminal-only through `npx briefroom init`.
- **Sharing switches remote access on.** Creating your first invite link while the install is solo prompts you to choose how people will reach it.
- **Kept from the 2026-11-11 spec:** the rules for the public address in `.env`, the permanent install ID, the phone QR test and the stricter defaults in public modes.

If the in-container approach fails verification, fall back to D-026: Settings shows the current mode and the command to change it.

## Joining, resets and removal

Kept from the 2026-11-11 spec, flows 3 to 8: invite links with role, expiry and use limit, joining from a browser, the bookmark for people who also host, the workspace switcher, password resets without email, and immediate revocation on removal.

One change: an invite link adds someone to the workspace only. Project access is given separately, as in "Access". An admin can pick projects while creating the link, so the invitee lands on them (Claude's call).

## Connecting agents

Kept from the 2026-11-11 spec: Briefroom ships as a Claude Code plugin. `briefroom login` connects it, `briefroom link` picks the workspace per repo, a repo that isn't linked reports nothing, and hooks time out after about a second and fail silently. Prompts and transcripts are never sent.

Additions:

- **Tokens match the UI.** An MCP token belongs to one account in one workspace. It sees exactly what that member sees in the web app: workspace-wide content, plus content of the projects they're on and of modules that are switched on.
- **Off-limits projects stay silent.** A repo linked to a project the member isn't on reports nothing, and MCP returns nothing for it.
- **Login may change.** Better Auth has an MCP plugin that makes the install an OAuth provider for MCP clients. If Claude Code's remote MCP login works with it, the browser approval in `briefroom login` can use it instead of a pasted token (see "Checks before building").

## Data rules

- **Workspace scoping in the database.** Every record carries a `workspace_id`, and project content also carries a `project_id`. Scoping is enforced in the database layer, never only in controller or tool code. Tests prove that a member can't reach a project they're not on, through the API and through MCP.
- **Tokens.** Hashed, per account and workspace, and revoked at once on removal.
- **Versioned API.** `/api/version` lets the CLI warn when it's out of date.
- **Export and import.** A workspace exports to one archive: the database rows and files for backup and moving, plus readable markdown and images so people can always leave (Claude's call on the markdown part).
- **Thumbnails** are stored next to full images, so remote members don't download full screenshots for every grid.

## Stack

| Layer | Choice | Decided by |
|---|---|---|
| API | NestJS 12 on the Node adapter | Marko, 2026-11-14 |
| Database access | Drizzle ORM v1 (release candidate at the time of writing) | Marko, 2026-11-14 |
| Database | Postgres 16 or newer with pgvector | Marko (D-004) |
| Auth | Better Auth, with the organization plugin for workspaces, members, roles and invitations, and the API key plugin for CLI and MCP tokens | Claude's call |
| NestJS and Better Auth | `@thallesp/nestjs-better-auth`, community-maintained and listed in Better Auth's docs. Fallback: mount Better Auth's handler directly | Claude's call |
| MCP | `@nestjs/mcp`, the official package, on the MCP TypeScript SDK v2 | Claude's call |
| Validation and contracts | Zod schemas in a shared package, used by the API, the frontend, the CLI and the MCP tools. NestJS 12 validates requests with them directly | Claude's call |
| Jobs | A Postgres-backed queue, so there is no Redis | Claude's call (C-13) |
| App frontend | React, TypeScript, Vite 8, TanStack Router, TanStack Query, Tailwind, shadcn/ui. Built to static files and served by the API through `@nestjs/serve-static` | Marko accepted after research, 2026-11-14 |
| Public site | Next.js for the landing page and the docs, in one project on Vercel. Shares UI components and tokens with the app | Marko (landing page in Next.js for performance), Claude's call on merging it with the docs |
| Images | sharp | Claude's call |
| Tests | Vitest or Jest for units, integration tests at the API and MCP boundaries, Playwright end to end | Claude's call, from Marko's defaults |
| Run | Docker Compose: `app`, `worker`, `db` | Marko (D-003) |

Why NestJS (Marko's reasons, 2026-11-14): it's more structured than Express or Hono, and it keeps Drizzle. Claude's reasons: NestJS modules map one to one onto Briefroom modules, and Better Auth covers workspaces, invites and tokens, which are the most security-sensitive parts.

Why the app uses Vite and not Next.js (researched 2026-11-14):

- **Behind a login.** The app is a pure client for the NestJS API. Comparisons from 2026 (ASoc, TECHSY, FocusReactive) give that case to Vite.
- **Runtime routes.** Next's static export can't serve routes like `/projects/[id]` unless every ID is known at build time (Next.js docs). Projects are created at runtime, so Next would need its own Node server next to NestJS. That's more memory on the host and a second place for server logic.
- **The trade-off.** FocusReactive measured Next painting a dashboard faster on slow mobile (568 ms against 1,312 ms on Slow 4G). Briefroom mostly runs on localhost, a LAN or a tunnel, where that gap matters less than an extra server process.
- **Vite is stable.** Vite 8 has been stable since March 2026, and its bundler Rolldown reached 1.0 in May 2026.

Why the public site uses Next.js: AI crawlers such as GPTBot and ClaudeBot don't run JavaScript, so public pages have to arrive as rendered HTML. The landing page and the docs live together, since the docs were already planned for Vercel (D-008).

## Repo layout

Claude's call. pnpm monorepo:

- `apps/api` is the NestJS app: core plus mounted modules, MCP and static frontend serving
- `apps/worker` is the job runner, built from the same code as a standalone NestJS context
- `apps/web` is the Vite frontend shell
- `apps/cli` is the `briefroom` CLI and the hook command
- `apps/site` is the public Next.js site with the landing page and the docs, deployed to Vercel and never part of the install
- `packages/contracts` holds the shared Zod schemas
- `packages/db` holds the Drizzle client, the core schema and the migrations
- `packages/ui` holds shared frontend components
- `modules/<name>/` holds `server/`, `schema/`, `web/` and `manifest.ts`

All modules ship together, so there is one migration history for the whole app, and each module's tables live in its own schema files (Claude's call).

## Left to the builder

- Whether Better Auth's organization roles hold Owner, Admin and Member directly, and whether project membership lives in its "teams" feature or in Briefroom's own table. Constraint: the access rules above stay exactly as written.
- Row-level security versus one query layer that always filters, for workspace and project scoping. Constraint: the tests in "Data rules".
- Which Postgres queue (pg-boss, graphile-worker or similar).
- Vitest or Jest.
- How the frontend calls the API: a thin typed client over the shared contracts, or OpenAPI generation on top.
- The export archive format.
- The exact shape of `init`'s questions and of the module manifest.
- The repo link file's name and whether it's ignored by git by default.

## Checks before building

- **Remote access from Settings:** running `cloudflared` and Tailscale (userspace networking) as child processes in the app container, with no extra container privileges. Includes Funnel's port rules and the current Tailscale free plan limits.
- **`@nestjs/mcp`:** whether `tools/list` can differ per request, so that tools of a switched-off module disappear. If not, those tools answer that the module is off.
- **`@thallesp/nestjs-better-auth`** against NestJS 12 and the Node adapter.
- **Better Auth's MCP plugin** with Claude Code's remote MCP login.
- **Drizzle v1's status** when the epic starts: stable, or still a release candidate.
- **The Claude Code plugin format** and `/plugin install`.
- **Every library** against current docs at the start of the epic that uses it.

## Later

- One account across installs.
- Viewing a bookmarked workspace inside your own app.
- Modules written by other people.
- Moving a project between workspaces.
- Codex support, then other agents.

## What this replaces

| Earlier | Now |
|---|---|
| Any account can create workspaces on its install (2026-11-11 spec) | Only the install owner creates workspaces on an install |
| Guest role "later" (2026-11-11 spec) | No guest, viewer or client roles at all |
| Members see all of a workspace (2026-11-11 spec) | Members see workspace-wide content and only their projects |
| Connection mode picked at install and changed in the terminal only (D-024, D-026) | Solo by default. Remote access from Settings, if verification passes |
| First workspace optional at first run | A personal workspace is created at first run |
| Stack: Next.js app with API routes (C-13, Tech Stack page) | NestJS API plus a Vite frontend served by it |
| Modules always on | Modules switched on per workspace |
| Design library shelves "References" and "Our work" (D-012) | A workspace library, project mockups visible to the project, and publishing into the library. The design session will settle the details |

## Next steps

1. Marko approves this doc.
2. `superpowers:writing-plans` for the foundation epic (BRIEF-1).
3. Update the vault Decision Log, Tech Stack, Features and Roadmap pages, then Jira BRIEF-1 and the Confluence Decision Log, to match.
