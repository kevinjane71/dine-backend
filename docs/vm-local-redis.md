# Self-hosted Redis on the pg-full-migration VM

The Postgres backend (`pg-full-migration` branch) runs on a GCP VM in **asia-south1
(Mumbai)**. Its cache now runs **on the same VM over loopback** — free, and
sub-millisecond — instead of a remote managed Redis.

**Firestore / `main` (Vercel) is unaffected** — it keeps its Upstash `KV_REST_API_*`
env. This is purely the VM deployment.

## Why this works with no code change

`utils/kvCache.js` (`getRedis()`) selects the client from env:

| Env on that host | Client used |
|---|---|
| `REDIS_URL` is **loopback** (`127.0.0.1` / `localhost` / `::1`) | **ioredis → local Redis** |
| else `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Upstash REST |

So the same committed code serves both: the VM points `REDIS_URL` at
`redis://127.0.0.1:6379`; Vercel keeps Upstash. Redis errors are caught and treated
as a cache miss (falls through to Postgres) — a Redis hiccup never breaks a request.

## VM facts

| | |
|---|---|
| VM | `dine-be-vm`, zone `asia-south1-a`, project `ascendant-idea-443107-f8` |
| Backend | `node server.js` (loads `/opt/dine-backend/env.json` → `require('./index.js')`), port 3003 |
| Redis | `redis-server` on `127.0.0.1:6379`, 384 MB, `allkeys-lru`, no persistence, loopback-only |
| Postgres | Cloud SQL `34.14.155.43:5432` (asia-south1) |

## Provision / re-provision

Run once on a fresh VM (idempotent). From a laptop with gcloud on
`malik.vk07@gmail.com`:

```bash
gcloud compute ssh dine-be-vm --zone asia-south1-a \
  --project ascendant-idea-443107-f8 --command "bash -s" < scripts/vm-local-redis-setup.sh
```

It installs Redis, configures it as a pure loopback cache, backs up `env.json`,
sets `REDIS_URL=redis://127.0.0.1:6379`, restarts the backend, and verifies.

## Verify caching + measure the speedup

```bash
# on the VM (read-only):
bash scripts/vm-cache-check.sh
# optional — time a real cached endpoint cold vs warm:
bash scripts/vm-cache-check.sh "http://localhost:3003/api/restaurants/<RID>" "<JWT>"
```

Healthy signs: `ping PONG`, `pg:*` keys present, a rising **hit ratio**, and the log
line `KV Cache: Initialized from REDIS_URL (local/standard Redis via ioredis)`.

## Rollback

`env.json` is backed up as `env.json.bak.<timestamp>` before each change. To revert
to the previous cache backend:

```bash
sudo cp /opt/dine-backend/env.json.bak.<timestamp> /opt/dine-backend/env.json
sudo systemctl restart dine-backend
```

## Notes / optional follow-ups

- Rate limiter logs `In-memory fallback (set RATELIMIT_REDIS_URL ...)`. With a single
  VM, in-memory is fine; set `RATELIMIT_REDIS_URL=redis://127.0.0.1:6379` only if it
  ever becomes multi-instance.
- To fully drop the dormant remote entries, remove `KV_REST_API_URL`,
  `KV_REST_API_TOKEN` and the old remote `REDIS_URL` from `env.json` (kept as a
  fallback for now).
- On VM reboot the cache starts empty and rebuilds from Postgres — expected.
