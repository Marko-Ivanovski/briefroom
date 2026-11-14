# Briefroom

Briefroom is a self-hosted home for what your coding agents don't know about you: your design taste, your rules and where your projects stand. You add to it while you work, and every agent reads it through one MCP server.

You install it once on your own machine. That install hosts a personal workspace you can invite others into, project by project.

## Status

Early development. Nothing is released yet. The foundation is being built first, then the modules one at a time.

- Design: [`docs/specs/2026-11-14-foundation-design.md`](docs/specs/2026-11-14-foundation-design.md)
- Plan: [`docs/plans/2026-11-14-brief-1-foundation.md`](docs/plans/2026-11-14-brief-1-foundation.md)

## Development

Needs Node 24, pnpm and Docker.

```sh
pnpm install
pnpm db:up
pnpm dev
```

## Branches

- `main` holds releases only.
- `dev` is where work lands, through pull requests from `feature/`, `fix/`, `chore/` and `docs/` branches.

## License

[MIT](LICENSE)
