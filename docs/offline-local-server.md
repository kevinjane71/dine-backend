# Offline / Local-Server Runbook (pg-full-migration)

Run the **real** `dine-backend` on ONE terminal against a **local Postgres**, so a
restaurant with 10–20 terminals keeps taking orders, billing, and printing KOTs with
**no internet**. Every other terminal is a thin client that points its API base at this
machine over the LAN. No logic is re-implemented — offline behaves exactly like cloud.

```
   [SERVER TERMINAL]  wired ethernet, decent spec
   ┌──────────────────────────────────────────┐
   │ dine-backend  node index.js      :3003    │  ← real API + billing/KOT logic
   │ local Postgres                   :5432    │  ← source of truth while offline
   │ LAN real-time (socket.io on :3003)        │  ← live events to every terminal
   └──────────────────────────────────────────┘
            ▲ HTTP + WebSocket over the LAN ▲
     Term2  Term3  Term4 … Term20   (Electron clients → http://<server-ip>:3003)
```

When the internet returns, the server keeps mirroring to the cloud (RTDB best-effort +
cloud sync, see "Sync back" below). Nothing on the client terminals changes.

---

## 0. Requirements (server terminal)

- Node.js 18+ (bundle it, or install once).
- PostgreSQL 14+ installed and running locally.
- A fixed / reserved LAN IP for this machine (DHCP reservation or static). All
  terminals will use it — e.g. `192.168.1.50`.
- Wired ethernet strongly recommended (this box is the whole store's backend).

---

## 1. Create the local database

```bash
# as the postgres superuser
createdb dine
psql dine -c "CREATE USER dine_app WITH PASSWORD 'choose-a-password';"
psql dine -c "GRANT ALL PRIVILEGES ON DATABASE dine TO dine_app;"
```

## 2. Load the schema

The most reliable way is to clone the **exact** production schema (guarantees every
column the code expects exists). Do this once, while online:

```bash
# from a machine that can reach Cloud SQL (one-time, online):
pg_dump --schema-only --no-owner --no-privileges \
  "postgresql://dine_app:PW@34.14.155.43:5432/dine?sslmode=no-verify" \
  > dine-schema.sql

# then load it into the local DB:
psql "postgresql://dine_app:choose-a-password@localhost:5432/dine" < dine-schema.sql
```

(Alternative, no cloud access: run the repo's `scripts/create-*.sql` and
`node scripts/create-*-tables.js` against your local `DATABASE_URL`. The pgAdapter
also auto-overflows unknown fields into each table's `extra_data` JSONB, so a
schema-clone stays forward-compatible.)

## 3. Seed this restaurant's data (one-time, online)

Point the backfill at the LOCAL database while it can still read Firestore:

```bash
# fills menu, tables, floors, staff, customers, offers, settings, recent orders…
DATABASE_URL="postgresql://dine_app:choose-a-password@localhost:5432/dine" \
  ./scripts/resync-all-pg.sh
```

For a single store you can also `pg_dump --data-only` just that restaurant's rows from
Cloud SQL and restore locally — faster than a full Firestore backfill.

## 4. Configure and start the server

```bash
cp .env.offline.example .env.local
#  → edit DATABASE_URL (local), JWT_SECRET (same as prod), leave KV_REST_API_* unset
npm ci
node index.js          # or: ./scripts/offline-server.sh  (adds preflight checks)
```

You should see:

```
🐘 PostgreSQL adapter enabled — reads/writes routed to PG
📶 LAN real-time (socket.io) ready — terminals get live events over the local network
🚀 Dine Backend server running on port 3003
```

If Firebase creds are omitted you'll also see
`⚠️ Firebase Admin unavailable — booting in OFFLINE (Postgres-only) mode` — that's expected.

## 5. Point the terminals at the server

On each of the other terminals set the API base to the server's LAN IP:

- **Electron app:** Settings → Local Server → `http://192.168.1.50:3003` (auto-discovered
  via mDNS where available; manual IP otherwise). The app also opens a socket.io
  connection to the same host for live order/table/KOT events.
- **Env-based clients:** `NEXT_PUBLIC_API_URL=http://192.168.1.50:3003`.

## 6. Verify offline (pull the internet cable)

1. Unplug WAN / disable internet on the whole LAN.
2. Log in on a client terminal (PIN or email/password — both work offline).
3. Take an order on Terminal A → it appears on Terminal B and the KOT prints in the
   kitchen (LAN real-time + local ESC/POS). 
4. Settle a bill → prints locally.
5. Re-check the same order on another terminal — totals, tax, offers all match.

---

## Sync back to the cloud

While offline, the local Postgres is the source of truth. When the internet returns:

- The RTDB mirror resumes automatically (best-effort, capped at
  `RTDB_PUSH_TIMEOUT_MS`), so cloud dashboards see new events.
- Push the offline orders/changes up with the backfill (local → cloud) or the sync
  worker (see the Phase-4 plan). Order IDs are UUIDs, so re-sync is idempotent.

## Notes & limits offline

- **Cash** works fully. **Card/UPI capture** needs the gateway online — mark those
  "pending-sync" and reconcile when back on.
- **Aggregators** (Zomato/Swiggy), **WhatsApp/SMS**, and **AI features** need internet
  and simply no-op offline.
- **First-ever account** (phone/Google OTP) must be created once online; after that,
  PIN/password login is fully offline.
- Keep this server on a UPS. Postgres WAL survives power loss; take a nightly
  `pg_dump` backup.
