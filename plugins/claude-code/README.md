# Briefroom plugin for Claude Code

Adds one MCP server, `briefroom`, which runs `briefroom mcp-proxy`. The proxy reads the repo's
`.briefroom.json`, uses the token that `briefroom login` saved on this machine, and forwards to your
install's `/mcp` endpoint. The plugin holds no address and no secret.

## Install

1. `npm i -g briefroom`, then `briefroom login <address>` and `briefroom link` inside the repo.
2. In Claude Code: `/plugin marketplace add <this repository>`, then `/plugin install briefroom@briefroom`.

For a single session without installing: `claude --plugin-dir ./plugins/claude-code`.

## Behaviour

- A repo that is not linked on this machine gets no tools and the message "This repo is not linked to a Briefroom workspace. Run briefroom link."
- A `.briefroom.json` that came from git is not enough. `briefroom link` must have been run here.
- When the install can't be reached, the tool list is empty and a call answers "Briefroom is offline.". The next call tries again.
- On Windows, if Claude Code can't start the `briefroom` command, use `cmd` with `["/c", "briefroom", "mcp-proxy"]` in `.mcp.json`.
