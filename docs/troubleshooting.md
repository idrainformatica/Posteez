# Troubleshooting

This page documents the production deployment of Post++ and the runbooks maintainers should follow when background jobs stop running. When scheduled posts are not publishing, check the Temporal task queues before debugging any posting logic.

## Production Deployment

The production stack runs on `MarketingVM` (`10.0.40.143`), reachable over SSH with key-pair authentication for the `mgiustini` user.

The server keeps a checkout of this repository at `~/Posteez`; every `docker compose` command runs from that directory. The application image is built locally as `postiz-app:local` and never pulled from a registry (see [Operations](/operations)).

Project containers:

- `postiz` runs nginx plus PM2 with three processes: `frontend`, `backend`, and `orchestrator` (the Temporal worker). The orchestrator health endpoint listens on port `3002` inside the container.
- `postiz-postgres` stores the application database `postiz-db-local` (user `postiz-user`).
- `postiz-redis` backs application queues.
- `temporal` is the Temporal server for namespace `default`, persisted by `temporal-postgresql` and `temporal-elasticsearch`.
- `temporal-ui` serves the Temporal UI on `127.0.0.1:8080`; open it through an SSH tunnel.
- `temporal-admin-tools` provides the `temporal` CLI used by every command below.

## Health Checks

The authoritative worker check is the task queue (run on `10.0.40.143`):

```bash
docker exec temporal-admin-tools temporal task-queue describe --task-queue main
```

A healthy worker shows recent `Pollers` entries and `ApproximateBacklogCount 0`. A workflow backlog with a multi-day `ApproximateBacklogAge` and an empty `Pollers` list means the orchestrator is running without workers and nothing will ever publish.

Also check the orchestrator process and its boot log:

```bash
docker exec postiz pm2 ls
docker exec postiz pm2 logs orchestrator --err --lines 50 --nostream
```

`Worker connection established to temporal:7233` must appear once per boot. `Failed to create worker connection, returning null` means the worker never started and the process is useless until it is restarted.

The health endpoint answers inside the container:

```bash
docker exec -i postiz node <<'NODE'
fetch('http://localhost:3002/health/status')
  .then((r) => r.text())
  .then(console.log);
NODE
```

Keep in mind that `/health/status` only proves Temporal is reachable, not that a worker is polling. The task-queue check is the authoritative one.

## Scheduled Posts Are Not Publishing

Observed in production starting from 2026-10-13, and again after the reboot on 2026-10-23.

Symptoms:

- Posts stay in `QUEUE` state past their `publishDate`.
- `postWorkflowV109` executions stay `Running` with `HistoryLength 2`: the first workflow task was never picked up by any worker.
- The `main` task queue shows a workflow backlog with a multi-day age and no pollers.

Root cause chain:

1. Every VM reboot starts all `restart: always` containers in parallel. The orchestrator boots in a few seconds, while `temporal` needs about a minute (auto-setup, Elasticsearch, healthchecks) before it accepts connections on port `7233`.
2. `docker-compose.yaml` gates `postiz` behind `temporal: condition: service_healthy`, but `depends_on` is only honored by `docker compose up`; host reboots and `docker compose restart` bypass it.
3. `nestjs-temporal-core@3.2.3` creates the client connection lazily and treats `Boolean(client.workflow)` as a health check, so the boot log prints `Successfully connected to temporal:7233` even while Temporal is still down.
4. The worker `NativeConnection.connect()` fails with `ConnectionRefused`. The library catches the error, logs `Failed to create worker connection, returning null`, and never retries.
5. The orchestrator process looks healthy and PM2 keeps it online, but no worker polls, so every scheduled workflow waits forever.

Recovery:

1. Restart the orchestrator with the clean procedure below while Temporal is healthy.
2. Wait for `Worker connection established to temporal:7233` in the logs and for a live poller on the `main` task queue.
3. Workflows whose `publishDate` has passed publish immediately once they resume. If the content is outdated, delete or reschedule those posts from the calendar first: deleting a post soft-deletes the row (`deletedAt`) and terminates its running workflow.

Repository fix: `apps/orchestrator/src/main.ts` awaits `waitForTemporal()` from `libraries/nestjs-libraries/src/temporal/temporal.module.ts` before creating the Nest application. The gate opens a real client connection, calls `describeNamespace`, and retries every 5 seconds for up to 10 minutes (tunable through `TEMPORAL_GATE_TIMEOUT_MS` and `TEMPORAL_GATE_RETRY_DELAY_MS`). If Temporal is still unreachable after the timeout the boot fails and PM2 restarts the process, so workers are only created once Temporal actually accepts connections.

The fix takes effect after the next image build and redeploy:

```bash
docker compose build postiz
docker compose up -d postiz
```

## Clean Orchestrator Restart

PM2 forks `pnpm start` per process, so the chain is `pm2 -> pnpm -> sh -> dotenv -> node`. `pm2 restart` only signals the head of the chain: the Node grandchildren survive as orphans, they keep port `3002` and keep polling, and every new boot dies with `EADDRINUSE` while PM2 crash-loops. Never run a bare `pm2 restart orchestrator` inside the container.

Safe procedure:

```bash
docker exec postiz pm2 stop orchestrator

docker exec -i postiz sh <<'EOF'
for d in /proc/[0-9]*; do
  cmd=$(tr '\000' ' ' < $d/cmdline 2>/dev/null)
  case "$cmd" in
    *apps/orchestrator/src/main.js*) kill ${d#/proc/} ;;
  esac
done
EOF

docker exec postiz pm2 start orchestrator
```

Then verify that the PM2 restart counter stops increasing, that the logs contain `Worker connection established`, and that the `main` task queue shows a single live poller.

A full `docker restart postiz` is always safe and clean (PM2 recreates every process from scratch) at the cost of a short backend and frontend outage.

## Post-Reboot Checklist

Run these after every host or Docker restart:

1. `docker ps` shows the project containers `Up` and `healthy`.
2. `docker exec postiz pm2 ls` shows `frontend`, `backend`, and `orchestrator` online with a stable restart counter.
3. `docker exec temporal-admin-tools temporal task-queue describe --task-queue main` shows live pollers and an empty backlog.
4. Every queued post has a future `publishDate`:

```bash
docker exec postiz-postgres psql -U postiz-user -d postiz-db-local -c "SELECT id, state, \"publishDate\" FROM \"Post\" WHERE \"deletedAt\" IS NULL AND state = 'QUEUE' ORDER BY \"publishDate\""
```

## Useful Commands

- List workflows: `docker exec temporal-admin-tools temporal workflow list --limit 20`
- Inspect a post workflow: `docker exec temporal-admin-tools temporal workflow describe --workflow-id post_<postId>`
- Terminate a workflow: `docker exec temporal-admin-tools temporal workflow terminate --workflow-id <workflowId> --reason <reason>`
- Orchestrator error logs: `docker exec postiz pm2 logs orchestrator --err --lines 100 --nostream`
- Temporal UI: `ssh -L 8080:127.0.0.1:8080 10.0.40.143`, then open `http://localhost:8080`
- The `postiz` container does not ship `ps`; inspect live processes by scanning `/proc/*/cmdline` as shown in the clean restart procedure.
