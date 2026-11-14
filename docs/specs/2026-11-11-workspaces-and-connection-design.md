# Workspaces, joining and connection modes

Design doc, 2026-11-11. Written from one brainstorming session with Marko. The design catalog gets its own session later, so this doc only covers how references get into it.

**Status:** superseded in part by `2026-11-14-foundation-design.md`. Read that doc first. Its "What this replaces" section lists what changed here.

Each choice below is marked as **Marko's** or **Claude's call**. Claude's calls are recommendations that Marko hasn't reviewed one by one yet.

## Intent

Briefroom is a local-first, open-source (MIT) web app for developers who build with coding agents. It has three modules: the design library, the agent board and the knowledge layer. Projects tie them together, and one MCP server exposes them. See the vault page `wiki/entities/Briefroom.md`.

This doc covers the part around the modules: who has an account where, how a team forms, how people anywhere in the world reach it, and how their agents connect.

Why it matters: a team might be an admin in the US and three or four people elsewhere. Setup has to be easy enough that strangers find the repo, star it, fork it and run it for their own team. Earlier vault decisions assumed one instance is one team on a LAN or Tailscale (D-005, C-03, C-12). This doc replaces those.

## Goals

- One person installs Briefroom and has a working, shareable workspace in about ten minutes.
- A teammate joins with a link and a browser. No install, no Docker.
- The host picks how people reach the install, from "this computer only" to their own domain.
- Members connect their agents with their own Claude subscription. Briefroom never holds a subscription token.
- Client work under NDA never leaks into the wrong workspace.

## Non-goals for v1

- One account that works across installs (moved to "Later").
- Showing another install's workspace inside your own app.
- Sending email. Invites, resets and alerts all work without it.
- A hosted version.
- Any built-in LLM call (C-04 stays).

## Anti-goals

These would make it a failure even if it technically works:

- A setup that needs editing YAML or opening router ports for the common case.
- Data replicated across installs, where a removed member keeps a copy.
- The app needing `docker.sock` or root to change its own config.
- Steering or messaging agents from the board (C-02 stays).

## Concepts

| Term | Meaning |
|---|---|
| Install | One running Docker Compose stack, on a PC, home server or VPS. Has a permanent install ID |
| Install owner | The person who ran `init`. Manages the install itself: connection mode, backups, updates, password resets |
| Account | Email and password, stored on one install. Accounts are per install (Marko, 2026-11-11) |
| Workspace | The unit people create and join. Holds the design library, the agent board, the knowledge layer and projects (Marko) |
| Membership | An account's role in one workspace |
| Bookmark | A saved link on your install to a workspace that lives on someone else's install |

**Workspaces are host-owned (Claude's call, Marko accepted the browser-join consequence).** A workspace's data lives on exactly one install. Members reach it there. Nothing is copied between installs. This keeps revocation real, avoids sync conflicts and keeps NDA data in one place. Replication was rejected for those reasons, and because Matrix and Anytype show how hard it gets.

An account can belong to any number of workspaces on its install and create more (Marko).

## Roles

Claude's call. Replaces C-03 ("two fixed roles").

| Role | Scope | Can |
|---|---|---|
| Owner | Workspace | Everything, including delete and transfer. One per workspace |
| Admin | Workspace | Invites, members, roles, workspace settings |
| Member | Workspace | Use all modules |
| Install owner | Install | Connection mode, backups, password resets. Separate from workspace roles |

A Guest role (read-only, for clients) comes later.

## Flows

### 1. Install and first run (host)

1. `npx briefroom init` in a terminal. It asks a few questions, writes `.env`, picks a Compose profile for the connection mode and downloads the Compose file. It never needs `docker.sock`.
2. `docker compose up -d`.
3. The terminal and the Docker logs show the address and a one-time setup code (Claude's call). The code stops a stranger on the network from claiming the install first.
4. Open the address, enter the code and create the first account. That account becomes the install owner.
5. Create a first workspace (name, optional icon), or skip.

`git clone` plus `cp .env.example .env` stays documented as the manual path.

### 2. Create a workspace

A "New workspace" button in the workspace switcher. Name only, the rest is optional. Works like Supabase's "New project" or Plane's workspace creation (Marko's reference point).

### 3. Invite links

Marko: invites are links, not emails.

Claude's calls on the details:

- An admin creates a link and picks a role (default Member), an expiry (default 7 days) and a use limit (default unlimited).
- Optional "approve each join", as in Anytype. Off by default.
- Links can be revoked and regenerated, as in Mattermost.
- Settings shows the link, a copy button and a QR code.

### 4. Join from a browser (main path)

1. The member opens the link.
2. If they have no account on that install, they create one (email and password). If they do, they log in.
3. They land in the workspace.

No install needed. This is the only join path most people use.

### 5. Join when you also host (bookmark)

Default agreed by Marko 2026-11-11.

Someone with their own install pastes the invite link into their own Briefroom. It still creates an account on the host install (steps above, opened in the browser). Their own install also saves a bookmark. Their switcher then lists their own workspaces plus the bookmarked ones, and clicking a bookmark opens the host's address.

They have two accounts, one per install. The browser or a password manager handles that. Single sign-on across installs is in "Later".

### 6. Switching workspaces

A switcher in the top-left, as in Plane and Slack. The last-used workspace opens by default.

### 7. Password reset without email

Claude's call:

- An admin can make a one-time reset link for a member and send it however they like.
- The install owner can run `briefroom reset-password <email>` on the host.

### 8. Leaving and removal

Removing a member ends their sessions and revokes their tokens at once. Their past records stay, labelled with their name.

## Connection modes

Marko: the host chooses the connection type during install. `init` asks "Who needs to reach Briefroom?"

| Mode | For | How | Needs |
|---|---|---|---|
| This computer only | Solo use | Binds to localhost | Nothing |
| Local network | Same office or home | Binds to the LAN, Caddy with a local certificate | Members trust the local CA once, or accept labelled plain HTTP |
| Tailscale (private) | Small remote teams who can install Tailscale | Tailscale sidecar container with `TS_AUTHKEY` | Each member joins the tailnet |
| Tailscale Funnel | Public URL with no domain | Sidecar plus `TS_SERVE_CONFIG` with `AllowFunnel` | Funnel enabled in the Tailscale admin console. Ports 443, 8443 or 10000 only. Bandwidth cap. The Personal plan is for non-commercial use |
| Cloudflare Tunnel | Public URL on your own domain, no open ports | `cloudflared` container with `TUNNEL_TOKEN`. Public hostname set in the Cloudflare dashboard | A domain on Cloudflare |
| Own domain | VPS or a server with open ports | Caddy with Let's Encrypt | DNS record, ports 80 and 443 |
| Own reverse proxy | People who already run one | App on a plain port, they handle TLS | Their proxy |

Ruled out: Cloudflare quick tunnels (a new random URL on every restart, no server-sent events, a cap of about 200 in-flight requests) and ngrok free (1 GB and 20,000 requests a month).

Default agreed by Marko 2026-11-11: **v1 changes the mode in the terminal only.** Settings shows the current mode, the public address and the command to change it (`npx briefroom init` again). Changing it from the UI comes later, because that would need Docker access from inside the app.

Rules that hold in every mode (Claude's calls):

- The app knows its public address from `.env` and sets Better Auth's `baseURL` and allowed hosts from it. Don't trust forwarded headers unless a known proxy is in front.
- The permanent install ID means a mode change doesn't break members' bookmarks or tokens. Their CLI updates the address on the next call.
- After `init`, show a QR code of the public address so the host can test it from a phone on mobile data.
- Public modes turn on stricter defaults: rate limits on login and invite routes, secure cookies, no open signup without an invite once the first account exists.
- Plain HTTP on a LAN isn't a secure context. Clipboard access and secure cookies fail there. That's why Caddy with a local certificate is the LAN default.

## Connecting agents

Marko: members use their Claude subscriptions, not the API.

Anthropic's rule (Feb 2026): Free, Pro and Max OAuth works only in Claude Code and claude.ai. The Agent SDK and third-party apps need API keys. So Briefroom never runs Claude itself and never stores a subscription token. Avoid `claude setup-token` on the server.

How it works (Claude's call):

1. **Briefroom ships as a Claude Code plugin** with the MCP server entry and the session hooks, installed with `/plugin install`. Codex gets its own setup later (C-10).
2. **`briefroom login`** in the member's terminal finds Claude Code (and Codex when present), adds the plugin if missing, then opens the browser so the member approves the connection on the host. Unblocked and Mobbin use this pattern. It replaces `npx briefroom connect <address> <token>`.
3. **`briefroom link`** runs once per repo and picks which workspace that repo reports to. It writes a small file in the repo, like `vercel link` or `supabase link`. Marko asked for "connect to one workspace at a time". Per-repo linking is Claude's refinement of that, because a global "active workspace" sends client work to the wrong place when you switch.
4. A repo that isn't linked reports nothing.
5. `briefroom disconnect` removes the plugin config and the tokens.

Hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) call `briefroom hook`. It adds the branch, the PR and the ticket key from git and gh, then posts to the host. A post times out after about one second and fails silently, so a host being offline never slows a session down (Claude's call). Prompts and transcripts are never sent (C-11).

Any feature that needs a model runs in the member's own Claude Code through MCP, never on the server (C-04).

The MCP server sends short usage instructions when an agent connects. MCP supports this. There's no separate Briefroom design skill, because the member's existing design skills can call the tools (Marko).

**Unverified:** whether Claude Code can log in to a remote MCP server with OAuth in a way that would replace the token from `briefroom login`. Check before building.

## Data rules

Claude's calls:

- Every record carries a `workspace_id`. Scoping is enforced in the database (Postgres row-level security or one query layer that always filters), not in the MCP tool code.
- Every record shows its origin: which person wrote it, or which agent and on whose behalf. MCP answers include the origin. Stored text is returned as content, never as instructions.
- Tokens are per account and per workspace, hashed, and revoked at once on removal.
- The API is versioned and exposes `/api/version`, so a member's CLI can warn when it's out of date.
- **Workspace export and import:** a single archive with the database rows and files. It serves as the backup, and as the way to move a workspace from a PC to a server.
- The design library stores thumbnails next to the full images, so remote members don't download full screenshots for every grid.

## Adding design references

Marko: most people, Marko included, don't pay for Mobbin or Refero, so manual capture comes first. Screenshots stay private to the workspace. Briefroom never ships a public sample library of other companies' screens.

v1 has four ways in (Marko confirmed these cover his workflow):

1. Paste a screenshot with Ctrl+V anywhere in the library.
2. Drag and drop or upload files.
3. Paste a URL. Briefroom stores the link, the page title and the favicon next to the screenshots.
4. The member's agent captures it with its own browser tool (Playwright, Claude in Chrome) and saves it through MCP with notes.

Later: a browser extension, and optional imports from Mobbin or Refero for people who pay for them. No headless browser on the server in v1, because it adds hundreds of MB to the install.

## Ideas kept from the research

The research of 2026-11-11 is summarised in the vault page `wiki/concepts/Competitor Landscape.md`.

- Detect agents and log in through the browser (Unblocked, Mobbin): `briefroom login` above.
- Origin on every record (agentmemory): in "Data rules".
- Optional `briefroom rules sync`, which writes a workspace's core rules into `.claude/rules/briefroom.md` in a linked repo, so agents keep them when the host is offline (Cursor team rules, Claude Code managed settings). Opt-in.
- A browser notification when one of your sessions waits for input (Claude Code Agent Monitor).
- A session page that lists the files changed (GitHub Mission Control). Paths only, no contents.
- README pitch: Anthropic's team analytics exist only on Team and Enterprise plans. Briefroom gives small groups on Pro and Max a shared view of who is working on what.

Rejected: steering agents from the board, leaderboards, putting MCP behind a paid tier, indexing Slack and other sources.

## Later

- One account across installs ("Sign in with your Briefroom"): the member's install vouches for them with a signed key, so no second password is needed. Marko found the full version too complex for v1. Keep v1's design from blocking it: store memberships with a stable account ID, and keep auth behind one module.
- Viewing a bookmarked workspace inside your own app.
- Changing the connection mode from Settings.
- Guest role for clients, read-only.
- Browser extension for capture. Mobbin and Refero imports.

## Left to the builder

- Whether Better Auth's organization plugin covers workspaces, members, roles and invitations well enough, or a small custom layer is simpler.
- The exact Compose profiles and the shape of `init`'s questions.
- Row-level security versus a single query layer for workspace scoping.
- File layout of the per-repo link file and whether it goes in `.gitignore` by default.
- The export archive format.

## Checks before building

- Remote MCP OAuth in Claude Code (see "Connecting agents").
- Tailscale's current free plan limits and Funnel rules.
- Cloudflare named tunnels with server-sent events and long-lived MCP connections.
- Claude Code plugin format and `/plugin install` against current docs.
- Every library against current docs at the start of the epic that uses it.

## Next steps

1. Run the builder check: a fresh subagent with `builder-check-prompt.md` from the brainstorming skill reads this doc. Sort what comes back into answered, minor (settle and mark as Claude's call) and Marko's questions. Ask Marko's in one message.
2. Marko approves the doc.
3. `superpowers:writing-plans` for the foundation epic (BRIEF-1), which now includes workspaces, invites and `init`.
4. Update the Jira stories for BRIEF-1 and BRIEF-4 and the Confluence Decision Log to match.
