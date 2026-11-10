# Contributing

Thanks for your interest in second-brain.

## Development setup

See the README quickstart. The short version: Node ≥ 24, Docker, pnpm ≥ 11,
then `pnpm install && pnpm dev`. The homepage shows live connectivity checks
for the local stack.

## Making changes

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- `pnpm typecheck && pnpm test` must pass. Integration tests self-skip
  without the local stack; run `pnpm stack:up` first to include them.
- Database changes: edit `packages/schema/src/db/schema.ts`, then
  `pnpm db:generate` to produce a migration. Never edit applied migrations.
- Keep merge requests small and focused, with a clear description of behavior
  changes.

## Reporting issues

Open an issue with reproduction steps. For anything security-sensitive, see
[SECURITY.md](SECURITY.md) instead of filing a public issue.
