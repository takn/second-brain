# second-brain

An LLM-maintained knowledge base and single pane of glass for an engineering
organization — project status, decisions, blockers, and deadlines synthesized
continuously from Slack, GitLab, Jira, Google Workspace, and meeting
transcripts, with every claim traceable to its source.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works.

## What it does

- **Ingestion funnel** — connectors pull Slack, GitLab, Jira, Google Workspace
  (Drive, Calendar, Meet transcripts, people directory); a staged
  collect → normalize → triage → extract pipeline keeps LLM cost proportional
  to signal, not volume. Raw artifacts are immutable and replayable.
- **Typed events** — decisions, blockers, status changes, deadlines; each with
  confidence and provenance back to the source message or document.
- **Synthesized narratives** — per-project status pages that cite events
  inline, flag contradictions, and never go stale.
- **Reject-only review** — agent updates apply automatically; humans reject or
  revert. Outbound actions (messages, email, issue creation) require approval.
- **Search + agent query** — fast full-text lookup, plus async ask-the-brain
  answers with citations.
- **Artifact studio** — reports, briefs, and digests generated from templates
  with human review before publishing.

## Layout

| Path | What |
|---|---|
| `web/` | Next.js + TypeScript app — UI and API routes |
| `worker/` | TypeScript queue consumers — funnel stages, connectors, agents |
| `packages/schema/` | Shared types, event taxonomy, Drizzle DB schema + migrations |
| `infra/` | Terraform/OpenTofu for the whole AWS deployment (App Runner, Fargate, RDS, S3, SQS) |
| `config/` | Local stack config (ElasticMQ queues) |
| `docs/` | Operational docs |

## Local development

Prereqs: Node ≥ 24, Docker, pnpm ≥ 11 (`npm install -g pnpm`). The local MinIO
image comes from this project's public registry mirror (anonymous pulls — no
login needed).

```bash
pnpm install
pnpm dev
```

`pnpm dev` does everything: creates `.env` from `.env.example` if missing, starts the local
stack (Postgres 18, MinIO, ElasticMQ) with health-check waits, applies DB migrations, then
runs web (http://localhost:3000) and worker together. The homepage shows live connectivity
checks for all three backing services.

Other useful commands:

```bash
pnpm stack:up      # just the docker services
pnpm stack:reset   # wipe volumes, restart, re-migrate
pnpm db:generate   # generate a migration after editing packages/schema/src/db/schema.ts
pnpm db:migrate    # apply migrations
pnpm typecheck     # all packages
pnpm test          # all packages
```

No AWS access is needed for local development — MinIO stands in for S3 and ElasticMQ for SQS.

## Deployment

Terraform in `infra/` describes a complete single-account AWS deployment: VPC,
RDS Postgres, S3, SQS, ECR, App Runner (web), ECS Fargate (worker), and a
GitHub OIDC role so CI deploys without stored cloud keys. Start with
[infra/README.md](infra/README.md): copy `infra/example.tfvars`, create the
state bucket, `tofu init -backend-config=backend.hcl`, and apply. On merge to
main, CI builds images, runs migrations as a one-off task (aborting the deploy
on failure), then rolls both services.

Connector credentials (Slack app, GitLab token, Google service account, Jira)
live in AWS Secrets Manager — see `docs/` for per-connector setup.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md) ·
security policy: [SECURITY.md](SECURITY.md)
