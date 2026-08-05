# Unified Offline/Online POS — Design & Build Plan

Status: DESIGN (Aug 2026). Target branch for backend work: `pg-full-migration` (Postgres).
Goal: **one desktop app** that any machine runs — it auto-picks its role, works fully
offline on the LAN, and auto-syncs to the cloud — with near-zero restaurant setup.
Your current **online** Electron app is NOT touched; this ships as a **separate sibling app**.

---

## 1. Goal

- **One installer.** Every device runs the identical app.
- **Auto role:** on launch it finds the LAN "Main" (mDNS). Found → becomes a Terminal.
  None → one-click "Make this the Main" (or auto if it's the only device).
- **Local-first:** every device reads/writes its **own local Postgres** first (instant),
  so offline↔online is invisible. Intermittent internet is a non-event.
- **Auto-sync:** Terminal → active Hub (LAN) → cloud (background), idempotent + resumable.
- **No hard SPOF:** every device is self-sufficient and **promotable to Hub**.

---

## 2. Architecture — the Toast playbook

Toast (the restaurant-POS gold standard) solves these exact problems with 5 principles.
We adopt them:

1. **Every device is an autonomous node** — its own local DB (we use **local Postgres**,
   bundled like today's `desktop-server`). No single server whose death stops service.
2. **GUIDs for every ID** — order/check/item/payment IDs are UUIDs generated on-device,
   instantly, offline → two offline devices can NEVER collide. (We already emit UUIDs for
   Firestore doc ids; make them the *canonical* id across PG + sync.)
3. **Sync EVENTS, not state** — devices emit idempotent commands
   (`item.added`, `item.voided`, `discount.applied`, `payment.added`, `order.settled`),
   ordered per-order. Merging replays events → no last-write-wins clobbering. We already
   event-source **tables**; extend the same to the **order lifecycle**.
4. **Cloud = eventual source of truth; LAN = real-time.** Each device syncs its event
   stream up when online. On the LAN, devices coordinate urgent actions (fire KOT/KDS)
   in real time even with no internet.
5. **Store-and-forward** for anything external (payments, cloud pushes, receipts).

**What we deliberately DON'T do (Toast doesn't either):**
- Do NOT hard-lock stock in real time across offline devices. Deduct **optimistically**
  locally, **reconcile on sync**, flag oversell to the manager. Fighting this is a losing
  battle in any distributed POS.
- Do NOT go full mesh (every-PG↔every-PG). Use **star topology**: all Terminals sync to the
  ONE active Hub (2-way, Hub is authority). Symmetry (any device promotable) WITHOUT the
  multi-master conflict nightmare.

---

## 3. Roles & topology

```
Terminal PG ──┐
Terminal PG ──┼──►  ACTIVE HUB (authoritative local PG)  ──►  CLOUD (eventual)
Terminal PG ──┘         ▲  mDNS-advertised on the LAN
                        └─ runs pg-BE (LOCAL_SERVER_MODE) + cloud-sync worker
```

- **Hub:** local Postgres (authoritative) + pg backend + mDNS advertise + cloud-sync worker.
- **Terminal:** POS UI pointed at the Hub; keeps **its own local Postgres** synced (2-way)
  so it works fully offline AND is instantly promotable.
- **Election:** first device up with no Hub found → becomes Hub. Others discover it. If the
  Hub disappears (crash/shutdown), Terminals detect the drop, keep working from local PG,
  and one is **promoted** (auto: lowest device-id that has the freshest synced state; or
  one-click "make this the Main"). On Hub return, roles reconcile.

---

## 4. The 3 hard problems → solutions

### 4a. Order numbers offline
- **Internal id = UUID** (never collides). This is the real key.
- **Human order/check number:** the **Hub is the only final-number issuer**. Offline a
  Terminal shows a **provisional number with a device tag** (e.g. `T2-tmp-0007`); on sync,
  the Hub assigns the authoritative sequential number and the Terminal swaps the label.
- Replaces today's `daily_order_counters.lastOrderId + 1` (which collides offline). Keep
  that counter, but only the **Hub** advances it.

### 4b. Stock oversell
- Hub PG is authoritative for stock. Terminals deduct **optimistically** in local PG.
- On sync, the Hub applies deductions in event order; if it would go negative → accept but
  **flag an oversell** for the manager (do not block the sale). This mirrors Toast.

### 4c. Hub failover
- Every device runs the same app + has a local PG kept in sync → **any is promotable**.
- Promotion = start advertising as Hub + become authoritative. Because the promoted device
  already has the synced data, there's no migration. The old Hub, on return, syncs its
  delta and steps down.

---

## 5. Data-model changes (pg branch, ADDITIVE, backward-compatible)

1. **Canonical UUID id** on orders/checks/items/payments (already have doc ids — formalize).
2. **`order_events` table** (append-only): `{event_id (uuid), order_id, seq, type, payload,
   device_id, created_at, applied}`. The order's current state is a **projection** of its
   events. Existing state columns stay (dual-write) so nothing breaks during rollout.
3. **`device_id`** stamped on every write (for provisional numbering + audit + reconcile).
4. **`sync_outbox`** per device: pending events not yet acked by the Hub (drives retry).

All additive — existing queries keep working; the event layer runs alongside.

---

## 6. Sync design

- Reuse **`idempotencyKey`** + **`POST /api/sync/batch`** (already exists) as the transport.
- Terminal → Hub: push `sync_outbox` events; Hub applies idempotently (by `event_id`), acks.
- Hub → Terminal: push new events since the Terminal's last cursor (keeps Terminals
  failover-ready). Star topology → only Terminal↔Hub, never Terminal↔Terminal.
- Hub → Cloud: background worker pushes events up + pulls cloud changes (online orders, HQ
  menu edits) down. Idempotent, resumable (cursor per stream).
- **LAN real-time** (KOT/KDS/table status): keep `lanRealtime.js` socket.io for instant
  fan-out; it's separate from the durable event sync.

---

## 7. Isolation — how this does NOT touch the online app

| Layer | What happens |
|---|---|
| **Online Electron shell** | UNTOUCHED. New offline app is a separate build target. |
| **POS UI (dine-frontend)** | SHARED. Already offline-aware (`localServer.js`, `useSyncEngine`, `lanRealtime`). Only ADDITIVE, flag-gated bits (role toggle, status pill) — online build never renders them. |
| **Online backend (main / Firestore)** | UNTOUCHED. All heavy work is on `pg-full-migration`. |
| **New offline shell** | NEW files: spawn local Postgres, start pg-BE in LOCAL_SERVER_MODE, mDNS, role manager, cloud-sync supervisor. |

Net: a **separate offline-capable desktop app** + additive changes. The current online app
keeps working exactly as-is.

### 7a. One build flag → two apps from ONE codebase (recommended)

A single build-time flag (e.g. `DINE_OFFLINE=1`) selects the target — **no code duplication,
same repo, same UI**:

| Flag | Result |
|---|---|
| (unset — default) | **Exact current ONLINE app.** Offline code is tree-shaken/excluded; behavior byte-identical to today. |
| `DINE_OFFLINE=1` | **Full offline+online app** — offline Electron shell, local Postgres, mDNS, Hub/Terminal roles, sync. |

- The offline Electron shell logic lives behind `if (process.env.DINE_OFFLINE)` in the main
  process; the online build never runs it.
- The additive FE bits (role toggle, status pill) are gated on the same flag (e.g.
  `NEXT_PUBLIC_DINE_OFFLINE`) → excluded from the online bundle.
- `electron-builder` gets two targets: **"DineOpen POS"** (online, as today) and
  **"DineOpen POS Offline"** (LAN/offline). Same source, two installers.

This GUARANTEES the online app is unaffected (its build contains none of the offline paths)
while avoiding a forked/duplicated codebase.

---

## 8. Phased build

| Phase | Deliverable | Reuse / status |
|---|---|---|
| **0 — Foundations** | LOCAL_SERVER_MODE BE, local PG, mDNS, sync engine, idempotency, event-sourced tables | ✅ already have |
| **1 — One app, two roles** | New offline Electron shell: bundle local PG + pg-BE; mDNS auto-discovery; Hub/Terminal role; role toggle UI (additive) | merge `desktop-server` capabilities into a new shell |
| **2 — Symmetric local-first** | Every device has local PG kept synced (star, 2-way); Terminal works fully offline + is promotable. Drop IndexedDB path for desktop. | extend `useSyncEngine` + `/api/sync/batch` |
| **3 — Toast hard problems** | UUID canonical ids; `order_events` + projection; provisional device-tagged numbers + Hub reconciliation; stock optimistic-deduct + oversell flag; Hub failover/promotion | new backend logic (additive) |
| **4 — Cloud-sync worker** | Continuous Hub↔cloud background sync (up + down), idempotent, resumable | extend `/api/sync/batch` |
| **5 — Polish** | Status pill (Online/LAN/Offline-syncing), conflict/oversell surfacing, self-heal, promotion UX | small FE |

Each phase ships independently and is testable on the LAN.

---

## 8b. Which users go Postgres vs Firestore — per-restaurant routing (from dine-admin)

**Firestore CANNOT run local/LAN offline** — its "offline" is client-side caching that needs
the cloud and can't do a LAN hub; the emulator is dev-only. So **offline REQUIRES the Postgres
stack.** That decides the strategy:

- **New / offline / migrated users → Postgres stack** (local PG offline + Cloud SQL + web→PG).
  One dialect end-to-end, no Firestore cost.
- **Existing Firestore users → stay on Firestore**, migrate to Postgres over time.
- Running both backends in parallel during the transition is normal; Postgres is the destination.

**You choose per-restaurant, dynamically, from dine-admin — this already exists:**
- A **`pgBackendUrl`** field on the restaurant doc. Set → that restaurant's frontend routes ALL
  API calls to the Postgres backend; unset → default (Firestore).
- **dine-admin → "Migration" tab** toggles it per restaurant (and there's a bulk endpoint).
  Backend: `PATCH /api/super-admin/restaurants/:id/backend` + `/restaurants/bulk-backend`
  (validate `https://`). Frontend `apiClient.setRestaurantBaseURL(restaurant)` reads
  `pgBackendUrl` on **login + dashboard boot** → instant switch, **no app rebuild**, instant
  rollback (clear the field).

So flipping a restaurant onto the Postgres/offline path is a **one-click, per-restaurant (or bulk)
control** in dine-admin — no redeploy, reversible.

**Caveats / verify before relying on it in production:**
- The very first login/bootstrap call hits the **default** backend, then switches to `pgBackendUrl`.
  To *fully* retire Firestore for a restaurant, auth/bootstrap must also route to Postgres (or
  keep the default backend alive just for login).
- The dine-admin Migration tab + endpoints exist in code but should be **tested end-to-end live**
  (toggle a test restaurant → confirm its traffic actually lands on the PG backend).

## 8c. Edge database choice (no query rewrite)

The `pgAdapter` generates **Postgres SQL**. Keep it that way to avoid a rewrite:

| DB | SQL? | Embedded (no server)? | Rewrite? | Use for |
|---|---|---|---|---|
| **PostgreSQL** | ✅ | ❌ | **none** — adapter already targets it | Hub + Cloud (+ terminals if hardware is decent) |
| **PGlite** (Postgres in WASM, in-process) | ✅ same dialect | ✅ | **none** | terminals if PG-server too heavy — fallback |
| **SQLite** (Toast's choice) | ✅ | ✅ | **YES** — needs a SQLite dialect in pgAdapter | only if cheap/flaky terminals force it |
| IndexedDB | ❌ NoSQL | ✅ | different model | avoid for desktop |

**Decision:** **Postgres everywhere** (Hub + terminals + Cloud) — zero rewrite, one dialect, matches
this branch; tune PG for crash-safety (WAL/fsync) for power-loss. **PGlite** is the drop-in fallback
(embedded Postgres, still no rewrite) if a terminal is too weak for a PG server. **Avoid SQLite** — it
forces a pgAdapter dialect rewrite; its edge-robustness edge mainly matters for cheap Android fleets.
Cloud DB = Cloud SQL Postgres, scales fine to many restaurants (it just receives idempotent writes).

## 8d. Sync mechanics (how the batches actually flow)

Not one-by-one API calls (chatty), not a big periodic batch (stale). **Incremental, event-driven,
batched, cursor-based** — this is **application-level sync over `/api/sync/batch`, NOT Postgres
native replication** (native replication can't do offline/intermittent/selective/auth):

1. Every write appends to a device **`sync_outbox`**.
2. A background worker sends pending rows to the cloud in **one HTTP call carrying many** (~50–200),
   fired ~1–2s after changes, drained fully on reconnect, ~20s heartbeat backstop.
3. Cloud applies idempotently (dedup by `event_id`), returns **ack + cursor**; device marks synced.
4. **Down** (Cloud→Hub): pull changes since the cursor (online orders, HQ menu) → apply to local PG.
   Star topology only: Terminal↔Hub and Hub↔Cloud (never Terminal↔Cloud when a Hub exists).

## 8e. Risks & invariants (design for these NOW)

Hidden landmines in any distributed offline POS (how Toast/we handle them):

1. **Clock skew** — never order events by device wall-clock (clocks drift). Use **Hub-assigned
   sequence** (or hybrid logical clocks) as the canonical order + per-order `seq` from the device.
2. **Split-brain (two Hubs)** — a LAN hiccup must not create two authoritative DBs. Elect the Hub
   with a **heartbeat lease**; become Hub only after no Hub answers for a timeout; loser reconciles
   and steps down on heal.
3. **Payments = exactly-once** — client-generated **payment UUID**, idempotent apply,
   store-and-forward, reconciliation report. Money gets the strictest handling; never double-charge.
4. **Mixed-version fleet** — after an app update some devices are old. **Version events** +
   backward-compatible migrations; the Hub must read older terminals' events; each device migrates
   its local DB on startup.
5. **Local data growth** — keep a **rolling window** locally (e.g. 30–90 days), full history in cloud.
6. **Offline auth on the LAN** — device tokens + staff PINs (LOCAL_SERVER_MODE + terminal PIN-lock);
   don't leave the LAN API open.
7. **Double-printing on replay** — **print-once by `event_id`** (idempotent print log).
8. **Menu/price mid-service** — **snapshot price onto the order at creation**; new price only for new orders.

## 9. Recommendation

- **Single active Hub + Postgres on every device** (star topology). Symmetric & failover-ready
  without multi-master pain.
- Build on **`pg-full-migration`**; keep it **additive** so the pg branch stays stable.
- Ship as a **separate offline app**; leave the online app untouched.
- The two upgrades that make it "click": **UUID order ids** + **event-sourced order lifecycle**
  (extending your existing event-sourced tables).

This is the Toast architecture, scoped to your stack — and you're already ~80% there.
