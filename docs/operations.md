# Operations

This page collects commands and deployment-sensitive notes for maintainers working in the monorepo.

## Package Manager

Use PNPM only. The root lockfile is `pnpm-lock.yaml`, and the root `package.json` declares:

```text
packageManager: pnpm@10.6.1
```

Do not use npm or yarn in this repository.

## Common Commands

Run commands from the repository root:

```bash
pnpm install
pnpm run dev
pnpm run build
pnpm test
pnpm run prisma-generate
pnpm run prisma-migrate-deploy
```

Docs commands:

```bash
pnpm docs:build:nav
pnpm docs:build
pnpm docs:serve
pnpm docs:preview
```

## App Builds

The root build runs the important app packages with workspace filters:

```bash
pnpm -r --workspace-concurrency=1 --filter ./apps/frontend --filter ./apps/backend --filter ./apps/orchestrator --filter ./apps/commands run build
```

Targeted builds are also available:

- `pnpm run build:backend`.
- `pnpm run build:frontend`.
- `pnpm run build:orchestrator`.
- `pnpm run build:commands`.

## Development Processes

`pnpm run dev` starts Docker dependencies and then runs backend, frontend, and orchestrator dev scripts in parallel.

Targeted dev scripts are available for backend, frontend, and orchestrator when you do not need the full stack.

## Local Docker Testing

`docker-compose.yaml` runs the `postiz` service from the published image (`ghcr.io/headzoo/postiz-app:latest`). To exercise local code changes against the full Compose stack, create an untracked `docker-compose.override.yaml` in the repository root (the file is gitignored, and plain `docker compose` commands merge it automatically):

```yaml
services:
  postiz:
    image: postiz-app:local
    build:
      context: .
      dockerfile: Dockerfile.dev
      args:
        NEXT_PUBLIC_VERSION: local
```

Build and start the stack with:

```bash
docker compose build
docker compose run --rm --no-deps postiz pnpm run prisma-migrate-deploy
docker compose up -d --wait
```

Run the `prisma-migrate-deploy` step whenever the change set ships Prisma migrations; application containers never migrate the database at startup (see [Database](/database)). The app is then reachable on `http://localhost:4007`, and the Temporal UI on `http://localhost:8080`.

`pnpm run docker-build` is a shortcut for `docker compose build postiz`.

To go back to the published image, remove or rename `docker-compose.override.yaml`, then:

```bash
docker compose pull postiz
docker compose up -d postiz
```

Never commit `docker-compose.override.yaml`: the VPS deployment runs plain `docker compose pull postiz`, and the override would make that pull fail.

## CI Notes

The main build workflow uses Node `22.12.0` and PNPM. Keep docs CI aligned with that runtime because the root package engine requires Node `>=22.12.0 <23.0.0`.

The docs Pages workflow deploys when documentation-related files change on `main`, and can also be dispatched manually.

## GitHub Pages Setup

The docs workflow expects repository Pages to use GitHub Actions as the source:

1. Open repository Settings.
2. Go to Pages.
3. Set Build and deployment Source to GitHub Actions.

The project Pages URL is:

```text
https://headzoo.github.io/postplusplus/
```

## Deployment-Sensitive Areas

Review these areas carefully before merging:

- Prisma migrations and schema changes.
- Temporal workflow/activity signatures.
- Public API request/response shapes under `/public/v1`.
- Auth middleware and authorization guards.
- Provider interface changes that affect multiple social integrations.
- Strategy-aware conversion rollout — see [Strategy-Aware Conversions](/conversions#deployment-and-rollback).

### Conversion Rollout Checklist

1. Apply the additive Prisma migration with `pnpm run prisma-migrate-deploy`.
2. Deploy backend and orchestrator in the same release window.
3. Verify `conversionEvaluationWorkflowV1` is registered and running in Temporal.
4. Rotate conversion webhook credentials per integration before sending webhook traffic; store the returned token immediately because it is shown only once.
5. Enable public API or webhook clients only after steps 1–3 succeed.

Rollback: stop new ingestion and the conversion worker if needed, but keep additive tables and ledger data intact. Do not delete production conversion rows during rollback.
