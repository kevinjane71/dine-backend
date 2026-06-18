# PostgreSQL Migration Progress

> This file tracks the Firestore → PostgreSQL migration progress across sessions.
> Updated at the end of each Claude Code session.

## GCP Infrastructure

| Item | Value |
|------|-------|
| GCP Project | ascendant-idea-443107-f8 |
| Cloud SQL Instance | dine-orders (asia-south1) |
| Cloud SQL Public IP | 34.14.155.43 |
| Database | dine |
| User | dine_app |
| Password | DineOrders2026Pg |
| DATABASE_URL | `postgresql://dine_app:DineOrders2026Pg@34.14.155.43:5432/dine?ssl=true&sslmode=no-verify` |
| Cloud Run URL | https://dine-backend-son5lc3cca-el.a.run.app |
| Vercel URL | https://dine-be2-phi.vercel.app |
| Authorized Networks | 0.0.0.0/0 (all IPs, needed for Vercel serverless) |

## Migration Status

### Collections

| Collection | % of reads | PG Table | Repo | Backfill | Endpoints Switched | Status |
|-----------|-----------|----------|------|----------|-------------------|--------|
| orders | 33% | ✅ `orders` | ✅ `ordersRepo.js` | ✅ 9,768 orders | ✅ 3 READ + 12 WRITE | **LIVE on Vercel** |
| inventory | 21% | ❌ | ❌ | ❌ | ❌ | Not started |
| restaurants | 11% | ❌ | ❌ | ❌ | ❌ | Not started |
| tables | 10% | ❌ | ❌ | ❌ | ❌ | Not started |
| dailyStats | 6% | ❌ | ❌ | ❌ | ❌ | Not started |

### Orders — Endpoint Details

**READ endpoints (PG primary, Firestore fallback):**
| Endpoint | Location in index.js | Status |
|----------|---------------------|--------|
| GET /api/orders/single/:orderId | ~line 10765 | ✅ Switched |
| GET /api/orders/:restaurantId | ~line 10884 | ✅ Switched |
| GET /api/kot/:restaurantId | ~line 20039 | ✅ Switched |

**WRITE endpoints (dual-write: Firestore primary + PG fire-and-forget):**
| Endpoint | Location in index.js | Status |
|----------|---------------------|--------|
| POST /api/orders | ~line 10047 | ✅ Dual-write |
| PATCH /api/orders/:orderId/status | ~line 12414 | ✅ Dual-write |
| PATCH /api/orders/:orderId | ~line 13649 | ✅ Dual-write |
| PATCH /api/orders/:orderId/cancel | ~line 21415 | ✅ Dual-write |
| DELETE (soft delete) | ~line 14505 | ✅ Dual-write |
| POST /api/orders/:orderId/refund | ~line 32020 | ✅ Dual-write |
| POST /api/orders/:orderId/partial-payment | ~line 32105 | ✅ Dual-write |
| POST /api/orders/:orderId/comp-void | ~line 32210 | ✅ Dual-write |
| PATCH /api/orders/:orderId/edit-completed | ~line 32409 | ✅ Dual-write |
| PATCH /api/orders/:orderId/edit-completed-items | ~line 32768 | ✅ Dual-write |
| KOT printed endpoint | ~line 20472 | ✅ Dual-write |
| Offline sync endpoint | ~line 36643 | ✅ Dual-write |

### Files Created/Modified

| File | Purpose | Status |
|------|---------|--------|
| `repos/pgClient.js` | PG connection pool | ✅ Created |
| `repos/fieldMapper.js` | camelCase ↔ snake_case mapping (109 fields) | ✅ Created |
| `repos/ordersRepo.js` | Orders data access layer (6 methods) | ✅ Created |
| `scripts/backfill-orders-pg.js` | Idempotent Firestore → PG migration | ✅ Created |
| `scripts/inspect-failed.js` | Debug/fix failed backfill rows | ✅ Created |
| `index.js` | PG feature flag + endpoint switching | ✅ Modified |

### Key Design Decisions

1. **Feature flag**: `const usePg = !!process.env.DATABASE_URL` — PG code dormant if env var not set
2. **Dual-write pattern**: Firestore primary, PG fire-and-forget (`.catch()` with error log)
3. **Field mapping**: 109 camelCase→snake_case mappings, unknown fields go to `extra_data` JSONB
4. **FieldValue handling**: Firestore sentinels (delete, serverTimestamp) detected via `isEqual` method, converted to null for PG
5. **Idempotent backfill**: ON CONFLICT (id) DO NOTHING, SAVEPOINTs per row

## Firestore Query Audit (2026-06-18)

**Total: ~7,755 Firestore operations across 111 files, 167 unique collections**

### Operations by Type

| Pattern | Count |
|---------|-------|
| `db.collection(` | 2,117 |
| `.get()` (reads) | 1,490 |
| `.where()` (filters) | 1,365 |
| `.doc()` (refs) | 1,314 |
| `.update()` | 556 |
| `.add()` | 273 |
| `FieldValue.serverTimestamp()` | 222 |
| `.set()` | 181 |
| `FieldValue.increment()` | 77 |
| `.delete()` | 74 |
| `batch` operations | 53 |
| `FieldValue.arrayUnion/Remove` | 17 |
| Transactions | 10 |
| RTDB refs (keep as-is) | 6 |

### Top Files by db.collection() Calls

| File | db.collection() | Total ops (approx) |
|------|----------------|-------------------|
| `index.js` | 820 | ~2,381 |
| `routes/superAdmin.js` | 77 | ~253 |
| `routes/parking.js` | 60 | ~202 |
| `services/functionCallingAgent.js` | 55 | ~193 |
| `payment.js` | 45 | ~165 |
| `chatbot.js` | 44 | ~161 |
| `routes/centralKitchenRoutes.js` | 39 | ~120 |
| `services/dineai/DineAIToolExecutor.js` | 38 | ~162 |
| `routes/attendance.js` | 36 | ~120 |
| `dodoPayment.js` | 35 | ~116 |
| `routes/hotelManagement.js` | 34 | ~145 |
| `routes/warehouseRoutes.js` | 33 | ~102 |
| `routes/hotel.js` | 30 | ~114 |
| `routes/roomManagement.js` | 27 | ~110 |
| `routes/shiftScheduling.js` | 23 | ~84 |
| `routes/aggregatorRoutes.js` | 22 | ~78 |
| `services/inventoryService.js` | 21 | ~82 |
| `routes/ownerDashboard.js` | 19 | ~69 |
| `invoice/routes/quotes.js` | 18 | ~61 |
| `routes/whatsappOrdering.js` | 15 | ~48 |

### Top Collections by Reference Count

| Collection | Refs | Migration Priority |
|-----------|------|-------------------|
| restaurants | 177 | Phase 3 (11% reads) |
| orders | 42 | ✅ DONE (33% reads) |
| dine_user_data | 40 | Low (auth — keep Firestore) |
| customers | 36 | Medium |
| rooms | 22 | Low (hotel feature) |
| offers | 18 | Low |
| dailyStats | 17 | Phase 5 (6% reads) |
| userRestaurants | 16 | Low (auth — keep Firestore) |
| staffShifts | 15 | Low |
| hotel_bookings | 15 | Low (hotel feature) |
| bolnaAgents | 15 | Low (AI feature) |
| inventory | 11 | Phase 2 (21% reads) |
| tables | 11 | Phase 4 (10% reads) |
| attendance | 11 | Low |

### What Stays on Firestore (no migration needed)

- **Auth collections**: dine_user_data, userRestaurants, staffCredentials — tightly coupled to Firebase Auth
- **RTDB**: deliveryService, firebaseRealtimeService — only 6 refs, real-time features
- **Low-traffic collections**: hotel_bookings, rooms, bolnaAgents, parking, etc.
- **Invoice system**: Separate module with own collections (invInvoices, invCustomers, etc.)

## Pending Tasks

- [ ] Catch-up backfill: orders created between 2026-06-17 (initial backfill) and dual-write going live
- [ ] Deploy to GCP Cloud Run with DATABASE_URL
- [ ] Add per-restaurant backend switching to frontends
- [ ] Build inventory repo + PG table + backfill
- [ ] Build restaurants repo + PG table + backfill
- [ ] Build tables repo + PG table + backfill
- [ ] Build dailyStats repo + PG table + backfill
- [ ] Gradual rollout to restaurants
- [ ] Cleanup: remove Firestore code paths after full migration

## Session Log

### 2026-06-17 (Session 1): Foundation + Orders Migration
- Set up GCP Cloud SQL instance (dine-orders, asia-south1)
- Created pgClient.js, fieldMapper.js, ordersRepo.js
- Backfilled 9,768 orders from Firestore to PG (8 errors, fixed with inspect-failed.js)
- Switched 2 of 3 READ endpoints to PG

### 2026-06-18 (Session 2): Complete Orders + Go Live
- Switched 3rd READ endpoint (KOT) to PG with shared `enrichKotOrders()` helper
- Added dual-write to 12 WRITE endpoints
- Handled FieldValue sentinels (delete, serverTimestamp) for PG compatibility
- Fixed PVR Rooftop customer account (deleted user doc, merged duplicates)
- Fixed analytics crash (dateBoundsInTZ receiving ISO timestamps instead of YYYY-MM-DD)
- Deployed to Vercel with DATABASE_URL — all endpoints verified working
- Opened GCP Cloud SQL to all IPs (0.0.0.0/0) for Vercel serverless access
- Created full migration plan (7 phases)

### 2026-06-18 (Session 3): Firestore Query Audit
- Ran comprehensive audit of all Firestore operations in dine-backend
- Found ~7,755 operations across 111 files, 167 unique collections
- index.js alone has 820 db.collection() calls (~2,381 total ops)
- Documented top files, top collections, and migration priorities
- Added full audit data to this progress file for future session reference
