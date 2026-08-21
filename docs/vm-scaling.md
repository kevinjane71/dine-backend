# pg VM scaling — Cloud SQL tier + Node clustering (Option A)

State of the pg-full-migration VM (`dine-be-vm`, asia-south1) after the 2026-08-21
"Option A" scale-up. Firestore/main (Vercel) is unaffected.

## What changed
| | Before | After |
|---|---|---|
| Cloud SQL tier | `db-f1-micro` (0.6 GB, shared) | **`db-g1-small`** (1.7 GB) |
| DB `max_connections` | 25 | **50** |
| Node process | 1 (single core) | **2-worker cluster** (both vCPUs) |
| Redis | local, loopback | unchanged (local) |
| Second backend | old Cloud Run also on the DB | **deleted** — one canonical backend |

## Node clustering (`server.js`)
`server.js` (the VM entrypoint) now forks `WEB_CONCURRENCY` workers (default
`min(vCPUs, 2)`) via the `cluster` module; each worker runs `index.js`. Node shares
the listen port across workers, so `app.listen()` is unchanged.

**Why it's safe here:** the in-process background singletons (`apiSyncWorker`,
`cloudSyncWorker`, `lanRealtime` socket.io, `lanDiscovery`) are all gated behind
`LOCAL_SERVER_MODE` / `CLOUD_SYNC_ENABLED`, which are **unset on the cloud VM** — so
nothing double-fires per worker. The only always-on timer is a per-process in-memory
rate-map cleanup (correctly per-worker). Verified both workers share traffic
(each accrued CPU time under load).

Crash-loop guard: >10 worker exits in 60 s → primary exits so systemd restarts clean.

## Pool sizing (must stay under DB max_connections)
Per-worker pg pool = `PG_POOL_MAX` (default 10). With 2 workers that's ≤ 20 of the 50
connections — safe, with headroom for `cloudsqladmin` + ad-hoc scripts. **Rule:**
`WEB_CONCURRENCY × PG_POOL_MAX  <  max_connections − ~5`. If you raise either, lower
the other or add PgBouncer.

## Measured
- Cached read (`/api/restaurants/:id`, served from local Redis): **cold ~38 ms →
  warm ~6–7 ms**.
- Single-process cached ceiling ≈ **350 req/s** (1 core).
- ⚠️ **On-box load tests understate clustering**: the load generator runs on the same
  2-core VM and competes with the 2 workers for CPU, so measured req/s doesn't rise.
  The gain (both cores used, better tail latency, DB-bound concurrency) shows under
  real *external* traffic. To benchmark properly, drive load from another machine.

## Rollback
- Clustering: `server.js.bak.<ts>` on the VM → `sudo cp` back + restart. Or set
  `WEB_CONCURRENCY=1` in env.json (runs single-process without reverting the file).
- Cloud SQL: `gcloud sql instances patch dine-orders --tier=db-f1-micro` (restarts DB).

## Next tier (Option B) when g1-small sweats
`db-custom-1-3840` (1 dedicated vCPU, 3.75 GB, more connections) + VM `e2-medium`.
See the cost table in the session notes.
