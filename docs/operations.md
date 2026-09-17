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

## Docker Builds And Deployment

`docker-compose.yaml` builds the `postiz` image from the repository sources with `Dockerfile.dev` and tags it `postiz-app:local`. Run every `docker compose` command from the repository root: the build context and the `./dynamicconfig` mount resolve from the current directory.

Build and start the full stack with:

```bash
docker compose build
docker compose run --rm --no-deps postiz pnpm run prisma-migrate-deploy
docker compose up -d --wait
```

Run the `prisma-migrate-deploy` step whenever the change set ships Prisma migrations; application containers never migrate the database at startup (see [Database](/database)).

Rebuild after every `git pull`: `docker compose up` reuses the existing `postiz-app:local` image and never rebuilds it automatically. Never run `docker compose pull postiz`; the image is local-only and is not published to a registry.

On the VPS Docker runs as root, so the same flow runs under `sudo`. `pnpm run docker-build` is a shortcut for `docker compose build postiz`.

The `spotlight` debugging service is gated behind the `debug` Compose profile: start it explicitly with `docker compose --profile debug up -d spotlight`.

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
