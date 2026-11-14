# Foundation checks (Task 1.0)

Run on 2026-11-14, Windows 11, Node v24.15.0, Docker 29.9.3 (Linux engine). Spikes lived outside the repo and are not committed. Every version below is the exact version tested.

## Summary

| Step | Check | Verdict |
|---|---|---|
| 1 | `@thallesp/nestjs-better-auth` on Nest 12 + Node adapter | pass |
| 2 | Better Auth server APIs | partial (one assumption fails: `disableSignUp` also blocks `auth.api.signUpEmail`) |
| 3 | `@nestjs/mcp` | partial (guarding and `ctx.request` pass, `tools/list` per request has no built-in hook, a verified workaround exists) |
| 4 | Remote access in a container | partial (pass for everything that needs no credentials, end-to-end deferred to Task 8.4) |
| 5 | Plugin format and MCP login | pass for plugin format, partial for MCP login (protocol level only) |
| 6 | Drizzle v1, Vitest + SWC | Drizzle v1 is an RC. Vitest recipe passes |

## Versions tested (pin these)

| Package | Version |
|---|---|
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-node`, `@nestjs/platform-express`, `@nestjs/testing` | 12.5.0 |
| `@thallesp/nestjs-better-auth` | 2.8.0 |
| `better-auth` | 1.7.23 |
| `@better-auth/api-key` | 1.7.23 |
| `@better-auth/mcp`, `@better-auth/oauth-provider`, `@better-auth/cimd` | 1.7.23 |
| `@nestjs/mcp` | 0.0.4 |
| `@modelcontextprotocol/server` (pulled in by `@nestjs/mcp`) | 2.4.0 |
| `zod` | 4.6.7 |
| `drizzle-orm`, `drizzle-kit` (rc tag) | 1.0.0-rc.5 |
| `vitest` | 5.1.0 (Vite 8.3.8) |
| `unplugin-swc` | 2.0.0 |
| `@swc/core` | 1.16.22 |
| `express` (needed at runtime, see Step 1) | 5.x |
| `pg` | 8.23.1 |
| `typescript` | 6.0.3 in the auth spike, 7.0.2 pulled by the Vitest spike |
| Tailscale (`tailscaled`, `tailscale`) | 1.104.7 |
| `cloudflared` | 2026.11.0 |

All Nest 12 packages and `@thallesp/nestjs-better-auth` are ESM only (`"type": "module"`). The app must be ESM.

---

## Step 1: `@thallesp/nestjs-better-auth` on Nest 12 with the Node adapter

- **Verdict:** pass
- **Method:** spike (Nest 12.5.0 app on `NodeAdapter`, run with tsx, Postgres 17 in Docker) plus package source.
- **Findings:**
  - Bootstrap that worked:
    ```ts
    import { NodeAdapter } from '@nestjs/platform-node';
    const app = await NestFactory.create(AppModule, new NodeAdapter(), { bodyParser: false });
    ```
    `app.getHttpAdapter().getType()` returns `'node'`. The package logs `AuthModule initialized BetterAuth on '/api/auth'`.
  - Module registration: `AuthModule.forRoot({ auth })` (object form). The `forRoot(auth, options)` form is deprecated. Extra module options: `isGlobal`, `disableGlobalAuthGuard`, `disableControllers`, plus `bodyParser: { json, urlencoded, rawBody }`, `disableTrustedOriginsCors`, `middleware`. `bodyParser: false` was set in `NestFactory.create` because the package says it disables Nest's own body parser. I did not test without it.
  - Exports used: `AuthModule`, `AuthService` (`.api`, `.instance`), `AuthGuard`, `Session` (param decorator), `AllowAnonymous`, `OptionalAuth`, `RequireActiveOrg`, `Roles`, `OrgRoles`, `UserHasPermission`, `MemberHasPermission`, `Hook` with `BeforeHook`/`AfterHook`, `DatabaseHook` with `BeforeCreate`/`AfterCreate`/`BeforeUpdate`/`AfterUpdate`/`BeforeDelete`/`AfterDelete`, type `UserSession<typeof auth>`. `Public` and `Optional` are deprecated aliases.
  - The auth guard is global by default: every route needs a session unless it has `@AllowAnonymous()`. Results: `GET /open` (anonymous) 200, `GET /me` without cookie 401, `GET /me` with a valid session cookie 200 `{"user":"nest@x.dev","sessionId":true}`, `GET /me` with a bogus cookie 401.
  - Sign-up (`POST /api/auth/sign-up/email`) and sign-in (`POST /api/auth/sign-in/email`) work through the mounted routes, and `GET /api/auth/get-session` returns the session.
  - **Hidden runtime dependency:** on any non-Fastify adapter the package does `require("express")` for body parsing (`getExpressBodyParser`). `express` is only an optional peer, but without it the app crashes at startup (`Error: Cannot find module 'express'`, verified by removing it). Install `express@5` as a real dependency even though the adapter is Node.
  - `trustedOrigins` must be a string array. A function triggers an error unless `disableTrustedOriginsCors: true`. The module calls `enableCors` with those origins.
  - Peer ranges: `@nestjs/common|core ^11.1.6 || ^12`, `better-auth >=1.5.0 <2.0.0`, `typescript ^5.9.2 || ^6`.
  - tsx does not emit decorator metadata. The spike used `reflect-metadata` and no constructor injection in its own classes.
- **What the plan does next:** Task 2.1 uses the module as planned (`AuthModule.forRoot({ auth, ... })`, `@Session()`, `@AllowAnonymous()`), no fallback needed. Add `express` to the dependencies of `apps/api`. Keep the `toNodeHandler(auth)` plus own `SessionGuard` fallback unused.

---

## Step 2: Better Auth server APIs

- **Verdict:** partial. Everything works except one assumption.
- **Method:** spike (script against Postgres 17 in Docker, `better-auth` 1.7.23 with `admin()`, `organization({ allowUserToCreateOrganization: false })`, `apiKey({ enableMetadata: true })`), plus `.d.ts` and source reading.
- **Findings:**
  - **Assumption fails.** With `emailAndPassword: { enabled: true, disableSignUp: true }`, the HTTP route `POST /api/auth/sign-up/email` returns `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` as wanted, but **`auth.api.signUpEmail(...)` from the server throws the same error**. The check is inside the endpoint body (`dist/api/routes/sign-up.mjs`) and does not look at whether the call came over HTTP.
  - **Working replacement:** the admin plugin's `auth.api.createUser({ body: { email, password, name, role } })`. Called with no headers and no request, it needs no session (it only checks a session when `ctx.request` or `ctx.headers` is present), creates the user with a hashed credential account, and the user can then sign in with `signInEmail`. Returned `user.role` was `"user"` by default.
  - `allowUserToCreateOrganization: false`: a signed-in user calling `createOrganization` gets `You are not allowed to create a new organization`. A server call `auth.api.createOrganization({ body: { name, slug, userId } })` (no headers) succeeds and returns the organization with an `id`. This fits "only the install owner creates workspaces".
  - `auth.api.addMember({ body: { userId, role: 'member', organizationId } })` works server side, no headers needed. Returns `{ organizationId, userId, role, createdAt, id }`.
  - Set a password without the old one, three ways, all verified:
    - `auth.api.setUserPassword({ body: { userId, newPassword }, headers })` (admin plugin). Needs a session whose `user.role` is `admin`. A normal user gets `You are not allowed to set users password`. Returns `{ status: true }`.
    - `(await auth.$context).password.hash(plain)` then `ctx.internalAdapter.updatePassword(userId, hash)`. No session needed, sign-in with the new password worked. `ctx.password` also has `verify`, `config`, `checkPassword`.
    - Reset by link is `auth.api.requestPasswordReset` and `auth.api.resetPassword`, but both depend on an email callback (`sendResetPassword`), so the "no email" rule means Task 2.x should use the first two.
  - Other server functions present in `auth.api`: `signInEmail`, `getSession`, `setRole`, `listUsers`, `banUser`, `unbanUser`, `removeUser`, `impersonateUser`, `revokeUserSessions`, `listUserSessions`, `createInvitation`, `removeMember`, `updateMemberRole`, `changePassword`, `setPassword`, `verifyPassword`.
  - **The `apiKey` plugin is no longer in `better-auth`.** It is `@better-auth/api-key` (`import { apiKey } from '@better-auth/api-key'`), peer `better-auth ^1.7.23`. Options seen in the types: `enableMetadata`, `references: 'user' | 'organization'`, `apiKeyHeaders`, `customAPIKeyGetter`, `enableSessionForAPIKeys`, `startingCharactersConfig`.
  - API keys: `auth.api.createApiKey({ body: { name, userId, metadata: {...}, permissions, expiresIn, organizationId } })` returned `{ id, key, metadata, referenceId (the user id), configId: 'default' }`. The plain key is only in the create response. The database stores a hash (stored value differed from the returned key). `metadata` is stored as a JSON string in the `metadata` column and returned as an object.
  - `auth.api.verifyApiKey({ body: { key } })` works server side with no session. Valid key returns `{ valid: true, error: null, key: { ...without the key field, metadata, referenceId, configId } }`, so metadata (for example the workspace id) is available after verification. A wrong key returns `{ valid: false, error: { code: 'INVALID_API_KEY' }, key: null }` and logs an error line.
  - Revocation: `auth.api.deleteApiKey({ body: { keyId }, headers })` needs the owner's session. Verify after delete returns `valid: false` at once (database storage, no cache).
  - Better Auth table names created: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `apikey`. These match the exemption list in the global constraints.
  - Migrations: `getMigrations(auth.options)` from `better-auth/db/migration` creates them. With Drizzle the plan will use the `@better-auth/drizzle-adapter` (1.7.23, peer `drizzle-orm ^0.45.2 || >=1.0.0-rc.1 <2`).
- **What the plan does next:** Task 2.x must not rely on `signUpEmail` with `disableSignUp: true`. Create the first owner and invited members with `auth.api.createUser` (admin plugin, role stays `user` and workspace roles live in `member`), or keep `disableSignUp: false` and gate the HTTP route with a `@BeforeHook('/sign-up/email')` that always rejects. Prefer `createUser`. Use `createOrganization` with `userId` and `addMember` server side. For admin password set use `setUserPassword` with an admin session, or `$context.password.hash` + `internalAdapter.updatePassword` for a no-session path. Install `@better-auth/api-key` for tokens and store the workspace id in key `metadata`.

---

## Step 3: `@nestjs/mcp`

- **Verdict:** partial
- **Method:** spike (Nest 12.5.0 on `NodeAdapter`, `@nestjs/mcp` 0.0.4, real HTTP JSON-RPC calls) plus reading the installed `.d.ts` and `.js`.
- **Findings:**
  - `McpModule.forRoot({ name, version, path, decorators, ... })` is confirmed. `path` defaults to `'mcp'` (`false` means no HTTP endpoint), `decorators` is `ClassDecorator[]` applied to the endpoint controller (for example `[UseGuards(TokenGuard)]`), `endpointVersion`, `imports`, and `include` (module list to scan for tools). Other options: `title`, `description`, `instructions`, `http: { legacy, responseMode, allowedHosts, allowedOrigins, maxRequestBodySize }`, `auth: { verifier, resource, authorizationServers, scopesSupported, requiredScopes }`. The module is served by the app's own HTTP adapter, so Nest guards and the global prefix apply.
  - Peer dependencies: `@modelcontextprotocol/server ^2.4.0` and `@modelcontextprotocol/client ^2.4.0` (optional, used by the test client), `zod >=4.2`.
  - Guarding: a guard in `decorators: [UseGuards(...)]` runs on every HTTP call, `tools/list` and `tools/call` alike. With a bad or missing token the response was 401 and no MCP payload.
  - Tool declaration: `@Tool({ name?, description, inputSchema: z.object({...}) })` on a provider method, signature `(args, ctx: McpContext)`. Also `@Resource`, `@ResourceTemplate`, `@Prompt`.
  - **`ctx.request` is exposed**: `McpContext.request` is the platform request (here the Node adapter's), so `req.user` set by the guard was readable in a tool (`{"user":{"id":"u1",...},"hasRequest":true,"kind":"tool","transport":"http"}`). Other context fields: `kind`, `name`, `uri`, `transport`, `era`, `authInfo`, `requestInfo` (web `Request`), `signal`, `server`, `reportProgress`.
  - **`tools/list` per request:** the MCP server object is rebuilt on every HTTP request (`McpServerFactory.create`, one per request, stateless) from `McpRegistry.tools`. There is no option or hook to filter per request. Out of the box, `tools/list` is the same for everyone and a call to a tool of a switched-off module runs unless the tool or a guard refuses.
  - **Workaround verified:** `McpRegistry` is a public export and `registry.tools` is read on each request. A provider that replaces `registry.tools` with a getter (`Object.defineProperty(registry, 'tools', { get })`) filtering by an `AsyncLocalStorage` value set by a guard gave a different list per request: a token with `notes` switched off listed only `whoami`, another token listed both, and `tools/call notes_add` for the first returned a JSON-RPC error `Tool notes_add not found`. This leans on an internal field of a 0.0.4 package that was published on 2026-11-04, so it may break in a later release.
  - Responses come as `text/event-stream` (`event: message`, `data: {...}`) even for single results under the default `responseMode: 'auto'` in this call style. Clients that send `Accept: application/json, text/event-stream` are fine.
- **What the plan does next:** Task 7.3 has two options. Safe default: keep all tools listed and make every module tool check its module switch and answer "module off" (this needs no internals). Optional: add the `McpRegistry.tools` getter plus `AsyncLocalStorage` filter, covered by one integration test so an upgrade that breaks it fails loudly. Plan on the safe default first and treat the filter as an upgrade. Pin `@nestjs/mcp` to 0.0.4 exactly.

---

## Step 4: Remote access from inside a container

- **Verdict:** partial. Both tools start and run in the restricted container. The end-to-end Tailscale check and the named-tunnel check need real credentials and are **deferred to Task 8.4 manual check with real credentials**.
- **Method:** spike in Docker. Image `node:24` (Debian, the task ruling says node:24 not node:22), tailscale 1.104.7 static binaries from `pkgs.tailscale.com`, `cloudflared` 2026.11.0 from the GitHub release. Run as user `node` (uid 1000), no `--cap-add`, no `/dev/net/tun`, not `--privileged`. Inside: `CapEff: 0000000000000000` and `/dev/net/tun` absent.
- **Findings:**
  - `tailscaled --tun=userspace-networking --state=/home/node/ts/tailscaled.state --socket=/home/node/ts/tailscaled.sock` starts as non-root and stayed alive for the whole run (checked after 4 s and again after the CLI commands). Without credentials it sits at `Logged out.` and prints an auth URL.
  - `tailscale up` without a key prints a login URL and times out as expected. `tailscale serve --bg 3000` and `tailscale funnel --bg 3000` are accepted as syntax and answer `Logged out. Log in at: <url>`, so they need an authenticated node. Not verified: an actual serve or funnel connection.
  - A full test needs a Tailscale auth key (`tailscale up --auth-key=<key>`, a reusable and ideally ephemeral key) on a tailnet where HTTPS certificates and MagicDNS are enabled and the `funnel` node attribute is allowed. In the app, the key would be passed by the app when it starts the child process.
  - `cloudflared --version` runs as non-root with no caps. `cloudflared tunnel --no-autoupdate --url http://localhost:3000` (a quick tunnel, no account) registered a connection and **a request from the host to the generated `*.trycloudflare.com` URL returned the local server's body with HTTP 200**. So cloudflared reaches a local HTTP server from a no-caps container.
  - `cloudflared tunnel run --token <fake>` starts, resolves, and then fails at the server with `ERR Register tunnel error from server side error="Failed to get tunnel"` and keeps retrying. A real token from the Cloudflare dashboard (a named tunnel with a public hostname pointing at `http://localhost:<port>`) is what a full test needs.
  - Warning seen: `failed to sufficiently increase receive buffer size` (UDP buffer for QUIC), harmless here. `--protocol http2` is the fallback if QUIC is blocked.
  - Tailscale Funnel rules (official docs, tailscale.com/kb/1223/funnel): listens only on ports **443, 8443 and 10000**. TLS only. Needs MagicDNS, HTTPS certificates enabled, and a `funnel` node attribute in the tailnet policy (the default policy lets `autogroup:member` use it). Needs Tailscale v1.38.3 or later. The same port cannot be used for Serve and Funnel at the same time. Bandwidth is limited and not configurable. Forwarding a port does not need root, serving a file, directory or socket does. Funnel is in beta and "available for all plans". The page does not mention userspace networking or containers.
  - Tailscale Personal (free) plan, from tailscale.com/pricing: up to **6 users**, **unlimited user devices**, up to 3 ACL groups, up to 50 tagged resources, 1,000 minutes per month for ephemeral resources, basic Tailscale SSH up to 5 hosts. The page says the ACL group, tagged and ephemeral limits are not enforced yet.
  - Tailscale's userspace-networking doc says the mode is for places that cannot create a tun device, such as containers, and that `tailscaled` then acts as a SOCKS5 or HTTP proxy for outbound traffic. Inbound serve and funnel in that mode are not described there, which is why the real-credential check is still needed.
- **What the plan does next:** keep Task 8.4. Build the `app` image on `node:24` with both binaries, run the app as a non-root user, and start `tailscaled --tun=userspace-networking` and `cloudflared` as child processes. Task 8.4 gets a manual check with real credentials: (1) Tailscale auth key, `serve` then `funnel` on 443 or 8443 or 10000, fetch the public URL. (2) Cloudflare tunnel token, fetch the public hostname. If either fails there, apply D-026 (Story 8 drops that part and Settings shows only the `briefroom init` command).

---

## Step 5: Claude Code plugin format and MCP login

- **Verdict:** plugin format pass (docs). MCP login partial (server side protocol verified, a real Claude Code login not run).
- **Method:** official docs (code.claude.com plugins reference, marketplace reference, install page, MCP page) and a spike of Better Auth's MCP plugin. No Claude Code login was performed.
- **Plugin file shapes for Task 7.5:**
  - Layout:
    ```text
    briefroom-plugin/
    ├── .claude-plugin/plugin.json
    ├── skills/<name>/SKILL.md
    ├── commands/*.md
    ├── hooks/hooks.json
    └── .mcp.json
    ```
    Only `plugin.json` goes in `.claude-plugin/`. Everything else sits at the plugin root.
  - `plugin.json`: only `name` is required (kebab-case, no spaces or `@`, and not starting with `claude-`, `anthropic-`, `cc-plugin-`). Useful fields: `displayName`, `version`, `description`, `author { name, email, url }`, `homepage`, `repository`, `license`, `keywords`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `userConfig`. Unknown top-level keys are stripped with a warning. Paths in the manifest must start with `./`.
  - Plugin MCP servers: declared in `.mcp.json` at the plugin root, or inline under `mcpServers` in `plugin.json`, or a path to a `.json` file. Shape is `{ "mcpServers": { "<name>": { ... } } }`. For a remote server the entry is `{ "type": "http", "url": "https://host/mcp", "headers": { "Authorization": "Bearer ${user_config.token}" } }`. A `url` entry without `type` is treated as stdio and is a config error. A stdio entry is `{ "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/proxy.js"] }`. Variables: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `${user_config.KEY}` (works in MCP `url`, `headers`, `command`, `args`, `env`).
  - `userConfig` option shape: `{ "type": "string", "title": "...", "description": "...", "sensitive": true, "required": true }`. Sensitive values go to the OS credential store.
  - Install. There is no direct "install from folder or git URL" command. A plugin is installed from a **marketplace**, and a marketplace is a folder or git repo with `.claude-plugin/marketplace.json`:
    ```json
    {
      "name": "briefroom",
      "owner": { "name": "Briefroom" },
      "plugins": [
        { "name": "briefroom", "source": "./plugin" }
      ]
    }
    ```
    `name`, `owner`, `plugins` are required. Entry `source` is a relative path starting with `./`, or an object `{ "source": "github", "repo": "owner/repo" }`, `{ "source": "url", "url": "<git url>" }`, `{ "source": "git-subdir", "url", "path" }`, `npm`, or `archive`. `briefroom` is not a reserved marketplace name.
  - Commands: `/plugin marketplace add ./path/to/marketplace` (local folder, needs the `./`), `/plugin marketplace add owner/repo`, or `/plugin marketplace add https://host/x.git`. Then `/plugin install briefroom@briefroom`. Shell forms: `claude plugin marketplace add <source>` and `claude plugin install briefroom@briefroom`. One step form (Claude Code 2.1.292 or later): `claude plugin install briefroom --marketplace <source>`. For a single-session test of a local plugin folder without a marketplace: `claude --plugin-dir ./briefroom-plugin`. `claude plugin validate <path>` checks a plugin or marketplace.
  - The plugin's skills show up as `/<plugin>:<skill>`.
- **MCP login with Better Auth:**
  - Better Auth's MCP plugin is no longer inside `better-auth`. It is `@better-auth/mcp` 1.7.23 (built on `@better-auth/oauth-provider`, uses `jwt()` from `better-auth/plugins`, optional `@better-auth/cimd`). Config tested: `mcp({ loginPage: '/login', consentPage: '/consent', resource: 'http://localhost:3100/mcp', allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true, clientRegistrationDefaultApplicationType: 'infer' })`. It cannot be combined with a separate `oauthProvider()`. DCR is off unless enabled explicitly. Its README says it owns authorization only and the MCP transport stays with `@modelcontextprotocol/server`.
  - Verified over `auth.handler`: `/.well-known/oauth-authorization-server/api/auth` and `/api/auth/.well-known/oauth-authorization-server` return 200 with issuer, authorization, token, jwks, registration (`/api/auth/oauth2/register`), introspection and revocation endpoints and `token_endpoint_auth_methods_supported` including `none`. `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` return `{"resource":"http://localhost:3100/mcp","authorization_servers":["http://localhost:3100/api/auth"],...}`. A dynamic client registration with `token_endpoint_auth_method: none` and a localhost redirect returned 201 with a `client_id`.
  - Claude Code's side, from its docs: it discovers via RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource`, falls back to RFC 8414 metadata, does dynamic client registration automatically or uses Client ID Metadata Documents, opens a browser login from `/mcp` or `claude mcp login <name>`, and stores and refreshes tokens. It treats `401`/`403` as needing sign-in. Options for servers that need them: `--callback-port`, `--client-id`/`--client-secret`, `oauth.scopes`, `oauth.authServerMetadataUrl`.
  - These line up, so a working login is likely, but I did **not** run Claude Code against it. Open items that only a real run can settle: the `/.well-known/oauth-protected-resource` files must be served at the origin root, outside the `/api/auth` mount and the Nest global prefix. The MCP route must return a `WWW-Authenticate` challenge pointing at the metadata (`@nestjs/mcp` has an `auth` option with `verifier`, `resource`, `authorizationServers` that serves the metadata and the challenge itself, which might be the simpler route). Plugin-provided `type: http` servers go through the same OAuth flow.
- **What the plan does next:** Task 7.5 writes the plugin and a one-entry `marketplace.json` as above, and the install instruction is `/plugin marketplace add <source>` then `/plugin install briefroom@briefroom`. The browser approval and local proxy stay as planned. Whether a later story can drop the proxy is **undecided**: the protocol pieces exist, a manual login test with real Claude Code is the deciding check. Record it as a follow-up when Story 7 has a running MCP endpoint.

---

## Step 6: Drizzle v1, Vitest and Nest

- **Verdict:** Drizzle v1 is a release candidate. Vitest + `unplugin-swc` passes.
- **Method:** npm registry (dist-tags, publish times), peer dependency data, Context7 docs for the Nest SWC recipe, and a spike (Vitest 5.1.0 with Nest 12.5.0).
- **Drizzle:**
  - `drizzle-orm` dist-tags: `latest` = 0.45.4 (2026-10-08), `rc` = **1.0.0-rc.5** (2026-10-21), `beta` = 1.0.0-beta.22. `drizzle-kit`: `latest` = 0.31.11, `rc` = 1.0.0-rc.5. There is no stable 1.0.0 yet. The v1 line has been in RC since 1.0.0-rc.1 (2026-04-30).
  - Compatible: `@better-auth/drizzle-adapter` 1.7.23 accepts `drizzle-orm ^0.45.2 || >=1.0.0-rc.1 <2`. `@nestjs/drizzle` 0.0.2 accepts `>=0.35.0 || >=1.0.0-0` (not needed, the plan uses a `packages/db` layer).
  - Pin choice: either `drizzle-orm@1.0.0-rc.5` with `drizzle-kit@1.0.0-rc.5` (exact versions, no caret), or the stable `0.45.4` with `drizzle-kit@0.31.11`. Both satisfy the Better Auth adapter. I did not exercise Drizzle itself in a spike.
- **Vitest with Nest:**
  - Nest's recipe (docs.nestjs.com/recipes/swc) is `npm i -D vitest unplugin-swc @swc/core @vitest/coverage-v8` and:
    ```ts
    import swc from 'unplugin-swc';
    import { defineConfig } from 'vitest/config';
    export default defineConfig({
      test: { globals: true, root: './' },
      plugins: [swc.vite({ module: { type: 'es6' } })],
    });
    ```
  - Spike result with that config (`vitest@5.1.0`, `unplugin-swc@2.0.0`, `@swc/core@1.16.22`, `@nestjs/testing@12.5.0`): 5 tests in 2 files passed. They covered constructor injection by emitted metadata with no `@Inject`, a cross-file provider, `overrideProvider`, `design:paramtypes` present, and a real HTTP request on `NodeAdapter`. `tsconfig.json` had `experimentalDecorators` and `emitDecoratorMetadata`.
  - Control: with no swc plugin and no tsconfig, the same-file test passed but a test importing a decorated class from another file failed with `SyntaxError: Invalid or unexpected token`. So keep the SWC plugin. It is what makes decorators reliable, not Vite's own transform.
- **What the plan does next:** Task 1.1 setup pins the Drizzle choice (recommend `1.0.0-rc.5` exact for both packages if the plan wants v1, otherwise `0.45.4`/`0.31.11`, and note the choice in the PR). Test setup uses the recipe above with `unplugin-swc` 2.0.0 and `@swc/core` 1.16.22.

---

## Spike cleanup

Spikes were under `C:/Users/Marko/.claude/jobs/0d156514/tmp/spikes/` (auth, mcp, vitest, remote). Docker artifacts: container `spikepg` (Postgres 17) and image `briefroom-remote-spike`, both removed after the run.
