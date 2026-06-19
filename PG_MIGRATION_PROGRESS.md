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
| inventory (7 collections) | 21% | ✅ 7 tables | ✅ 6 repos | ✅ 24,937 docs | ✅ 13 READ + 10 WRITE + 4 service | **READY for deploy** |
| restaurants | 11% | ✅ `restaurants` | ✅ `restaurantsRepo.js` | ✅ 480 docs | ✅ 1 READ (via kvCache) + 8 WRITE | **READY for deploy** |
| floors+tables | 10% | ✅ `floors` + `tables` | ✅ `floorsTablesRepo.js` | ✅ 497 floors, 8169 tables | ✅ 3 READ + 15 WRITE | **READY for deploy** |
| dailyStats | 6% | ✅ `daily_stats` | ✅ `dailyStatsRepo.js` | ✅ 851 docs | ✅ 7 READ + 2 WRITE | **READY for deploy** |

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

### dailyStats — Endpoint Details

**READ endpoints (PG primary, Firestore fallback):**
| Endpoint | Location | Status |
|----------|----------|--------|
| GET /api/owner/analytics (today) | index.js ~11440 | ✅ Switched |
| GET /api/owner/analytics (7d/30d/all) | index.js ~11500 | ✅ Switched |
| GET /api/owner/dashboard daily-summary | index.js ~11968 | ✅ Switched |
| GET /api/owner/analytics sub-restaurant breakdown | index.js ~12216 | ✅ Switched |
| GET /api/books/revenue | index.js ~28255 | ✅ Switched |
| GET /api/books/profit-loss | index.js ~28769 | ✅ Switched |
| GET /api/books/overview | index.js ~28901 | ✅ Switched |
| GET /api/super-admin/stats (dashboard) | routes/superAdmin.js ~130 | ✅ Switched |
| GET /api/super-admin/orders/summary | routes/superAdmin.js ~1275 | ✅ Switched |

**WRITE endpoints (dual-write: Firestore primary + PG fire-and-forget):**
| Function | Location | Status |
|----------|----------|--------|
| updateDailyStats() | index.js ~347 | ✅ Dual-write |
| updateDailyStatsRevenueDiff() | index.js ~455 | ✅ Dual-write |

**Repo methods:** getById, getByIds, getByDate, getByDates, getSubRestaurantStats, atomicUpsert, upsertRevenueDiff, create

**PG functions:** daily_stats_merge_jsonb (recursive JSONB deep merge with additive numbers), daily_stats_merge_array (array union with dedup)

### Floors + Tables — Endpoint Details

**READ endpoints (PG primary, Firestore fallback):**
| Endpoint | Location | Status |
|----------|----------|--------|
| GET /api/floors/:restaurantId | index.js ~16336 | ✅ Switched (2 queries vs N+1) |
| GET /api/tables/:restaurantId (legacy) | index.js ~15812 | ✅ Switched |
| Table lookup during order creation | index.js ~9253 | ✅ Switched (findTableDirect/findTableByName) |

**WRITE endpoints (dual-write: Firestore primary + PG fire-and-forget):**
| Endpoint/Function | Location | Status |
|----------|----------|--------|
| POST /api/tables/:restaurantId (create) | index.js ~15938 | ✅ Dual-write |
| POST /api/tables/:restaurantId/bulk | index.js ~16035 | ✅ Dual-write |
| PATCH /api/tables/:tableId/status | index.js ~16189 | ✅ Dual-write |
| PATCH /api/tables/:tableId | index.js ~16337 | ✅ Dual-write |
| DELETE /api/tables/:tableId | index.js ~16404 | ✅ Dual-write |
| POST /api/tables/:restaurantId/reset-all | index.js ~16277 | ✅ Dual-write |
| POST /api/floors/:restaurantId (create) | index.js ~16616 | ✅ Dual-write |
| PATCH /api/floors/:floorId (update) | index.js ~16675 | ✅ Dual-write |
| PATCH /api/floors/reorder/:restaurantId | index.js ~16768 | ✅ Dual-write |
| DELETE /api/floors/:floorId | index.js ~16807 | ✅ Dual-write |
| Table claim (order creation) | index.js ~9330 | ✅ PG atomic claim (UPDATE...WHERE status='available') |
| Table occupy (post-order) | index.js ~10503 | ✅ Dual-write |
| Table release (order completion) | index.js ~14131 | ✅ Dual-write |
| Table release (order deletion) | index.js ~14734 | ✅ Dual-write |
| Table release (order cancellation) | index.js ~21694 | ✅ Dual-write |
| Move order table swap | routes/moveOrder.js ~138 | ✅ Dual-write |

**Repo methods (25):** getFloors, getFloorById, createFloor, updateFloor, reorderFloors, deleteFloor, getTablesByRestaurant, getTablesByFloor, getFloorsWithTables, findTableDirect, findTableById, findTableByName, claimTable, releaseTable, releaseTableByName, occupyTable, updateTableStatus, updateTable, resetAllTables, createTable, createTablesBatch, deleteTable, updateFloorNameOnTables, backfillFloor, backfillTable

**Key design:** Firestore subcollection `restaurants/{rid}/floors/{fid}/tables/{tid}` flattened to 2 PG tables with explicit `restaurant_id` + `floor_id`. Floor IDs are slug-based (not globally unique) — composite PK `(id, restaurant_id)` required. Table claiming uses atomic `UPDATE...WHERE status='available'` instead of Firestore transaction. `getFloorsWithTables()` uses 2 parallel queries instead of N+1.

### Restaurants — Endpoint Details

**READ endpoints (PG primary via kvCache, Firestore fallback):**
| Endpoint | Location | Status |
|----------|----------|--------|
| All 29 files using `getCachedRestDoc()` | utils/kvCache.js | ✅ Switched (Redis → PG → Firestore fallback) |

**WRITE endpoints (dual-write: Firestore primary + PG fire-and-forget):**
| Endpoint | Location | Status |
|----------|----------|--------|
| POST /api/restaurants (create) | index.js ~6491 | ✅ Dual-write |
| PATCH /api/restaurants/:restaurantId (update) | index.js ~6657 | ✅ Dual-write |
| DELETE /api/restaurants/:restaurantId | index.js ~6687 | ✅ Dual-write |
| PUT /api/restaurants/:restaurantId/customer-app-settings | index.js ~32026 | ✅ Dual-write |
| PUT /api/restaurants/:restaurantId/pricing-settings | index.js ~32148 | ✅ Dual-write |
| PUT /api/restaurants/:restaurantId/billing-settings | index.js ~32341 | ✅ Dual-write |
| POST /api/restaurants/:restaurantId/generate-code | index.js ~33936 | ✅ Dual-write |
| POST /api/razorpay-oauth/callback (connect) | razorpayOAuth.js ~275 | ✅ Dual-write |
| POST /api/razorpay-oauth/disconnect | razorpayOAuth.js ~134 | ✅ Dual-write |

**Repo methods (11):** getById, getByIds, getAll, getSubRestaurants, getBySubdomain, getByUrlSlug, getByCode, create, update, remove, count

**Key design:** PG integrated into `getCachedRestDoc()` as middle tier: Redis hit → return. Redis miss → PG read → cache. PG miss → Firestore fallback. Only 1 file change (utils/kvCache.js) covers all 29 files that read restaurant data. Restaurant schema has 52 columns: simple fields + 17 JSONB columns for complex settings.

### Inventory Ecosystem — Endpoint Details

**7 PG tables:** `inventory`, `inventory_transactions`, `stock_batches`, `waste_entries`, `recipes`, `bar_bottles`, `bar_reconciliation`

**6 Repos:** `inventoryRepo.js` (11 methods), `inventoryTransactionsRepo.js` (7 methods), `stockBatchesRepo.js` (12 methods), `wasteEntriesRepo.js` (4 methods), `recipesRepo.js` (7 methods), `inventoryFieldMapper.js`

**Backfill:** 24,937 docs total (inventory 1,808, inventoryTransactions 21,807, stockBatches 399, wasteEntries 27, recipes 896, barBottles 0, barReconciliation 0)

**READ endpoints (PG primary, Firestore fallback):**
| Endpoint | Location | Status |
|----------|----------|--------|
| GET /api/inventory/:restaurantId (main list + wastage enrichment) | index.js ~22887 | ✅ Switched |
| GET /api/inventory/:restaurantId/categories | index.js ~23067 | ✅ Switched |
| GET /api/inventory/:restaurantId/dashboard | index.js ~23121 | ✅ Switched |
| GET /api/inventory/:restaurantId/transactions | index.js ~23261 | ✅ Switched |
| GET /api/inventory/:restaurantId/usage-summary | index.js ~23394 | ✅ Switched |
| GET /api/inventory/:restaurantId/:itemId/batches | index.js ~24129 | ✅ Switched |
| GET /api/inventory/:restaurantId/:itemId/history | index.js ~24176 | ✅ Switched |
| GET /api/inventory/:restaurantId/wastage | index.js ~24243 | ✅ Switched |
| GET /api/inventory/:restaurantId/waste-entries | index.js ~24440 | ✅ Switched |
| GET /api/inventory/:restaurantId/expiry-alerts | index.js ~24914 | ✅ Switched |
| GET /api/inventory/:restaurantId/waste-summary | index.js ~25025 | ✅ Switched |
| GET /api/inventory/:restaurantId/:itemId (single item) | index.js ~26161 | ✅ Switched |
| GET /api/recipes/:restaurantId | index.js ~26277 | ✅ Switched |

**WRITE endpoints (dual-write: Firestore primary + PG fire-and-forget):**
| Endpoint | Location | Status |
|----------|----------|--------|
| POST /api/inventory/:restaurantId (create item + batch + tx) | index.js ~23897 | ✅ Dual-write |
| PATCH /api/inventory/:restaurantId/:itemId (update) | index.js ~24053 | ✅ Dual-write |
| DELETE /api/inventory/:restaurantId/:itemId | index.js ~24109 | ✅ Dual-write |
| POST /api/inventory/:restaurantId/waste-entries | index.js ~24426 | ✅ Dual-write |
| POST /api/inventory/:restaurantId/stock-audits | index.js ~24669 | ✅ Dual-write |
| POST /api/inventory/:restaurantId/production-entries | index.js ~24807 | ✅ Dual-write |
| POST /api/recipes/:restaurantId (create/replace) | index.js ~26452 | ✅ Dual-write |
| PATCH /api/recipes/:restaurantId/:recipeId | index.js ~26655 | ✅ Dual-write |
| DELETE /api/recipes/:restaurantId/:recipeId | index.js ~26689 | ✅ Dual-write |

**Service-level dual-writes (inventoryService.js):**
| Function | Purpose | Status |
|----------|---------|--------|
| deductInventoryForOrder() | FIFO batch deduction on order placement | ✅ PG transaction dual-write |
| restoreInventoryForOrder() | Reverse deductions on cancel/delete | ✅ PG transaction dual-write |
| restoreInventoryForEditedOrder() | Reverse removed items on edit | ✅ PG transaction dual-write |
| createDefaultRecipe() | AI recipe + auto-create inventory items | ✅ PG dual-write |

**Key design:**
- 7 Firestore collections → 7 PG tables (1:1 mapping)
- FIFO batch deduction logic stays in JS, PG transactions replace Firestore batch writes
- `decrementBatch(client, batchId, amount)` / `incrementBatch(client, batchId, amount)` accept transaction client
- Stock audit sets physical count directly (not increment), creates waste entries for shrinkage
- Production entries add stock + create batch + log transaction in PG
- Expired batches auto-detected during order deduction, marked as waste

### Files Created/Modified

| File | Purpose | Status |
|------|---------|--------|
| `repos/pgClient.js` | PG connection pool | ✅ Created |
| `repos/fieldMapper.js` | camelCase ↔ snake_case mapping (109 fields) | ✅ Created |
| `repos/ordersRepo.js` | Orders data access layer (6 methods) | ✅ Created |
| `scripts/backfill-orders-pg.js` | Idempotent Firestore → PG migration | ✅ Created |
| `scripts/inspect-failed.js` | Debug/fix failed backfill rows | ✅ Created |
| `index.js` | PG feature flag + endpoint switching | ✅ Modified |
| `scripts/create-daily-stats-table.sql` | daily_stats PG schema (43 columns) | ✅ Created |
| `repos/dailyStatsFieldMapper.js` | camelCase ↔ snake_case + dynamic key aggregation | ✅ Created |
| `repos/dailyStatsRepo.js` | dailyStats data access (8 methods) | ✅ Created |
| `scripts/backfill-daily-stats-pg.js` | Firestore → PG migration (851 docs migrated) | ✅ Created |
| `routes/superAdmin.js` | PG switch for dailyStats reads | ✅ Modified |
| `scripts/create-floors-tables.sql` | floors + tables PG schema | ✅ Created |
| `repos/floorsTablesFieldMapper.js` | Floor/table camelCase ↔ snake_case mapping | ✅ Created |
| `repos/floorsTablesRepo.js` | Floors+tables data access (25 methods) | ✅ Created |
| `scripts/backfill-floors-tables-pg.js` | Two-pass Firestore → PG migration | ✅ Created |
| `routes/moveOrder.js` | PG dual-write for table swap | ✅ Modified |
| `scripts/create-inventory-tables.sql` | 7 inventory PG tables | ✅ Created |
| `repos/inventoryFieldMapper.js` | Field mapping for all 7 inventory collections | ✅ Created |
| `repos/inventoryRepo.js` | Inventory items CRUD + stock queries (11 methods) | ✅ Created |
| `repos/inventoryTransactionsRepo.js` | Transaction log queries (7 methods) | ✅ Created |
| `repos/stockBatchesRepo.js` | Batch tracking + FIFO deduction (12 methods) | ✅ Created |
| `repos/wasteEntriesRepo.js` | Waste entry CRUD (4 methods) | ✅ Created |
| `repos/recipesRepo.js` | Recipe CRUD (7 methods) | ✅ Created |
| `scripts/backfill-inventory-pg.js` | Multi-collection migration (24,937 docs) | ✅ Created |
| `services/inventoryService.js` | PG dual-writes for deduction/restore | ✅ Modified |

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
- [x] Build inventory repo + PG tables + backfill (7 collections, 24,937 docs)
- [x] Switch inventory READ endpoints (13 endpoints) + dual-write (10 endpoints + 4 service functions)
- [x] Build restaurants repo + PG table + backfill
- [x] Build floors+tables repo + PG tables + backfill
- [x] Switch floors+tables READ endpoints (3 endpoints) + dual-write (15 functions)
- [x] Build dailyStats repo + PG table + backfill
- [x] Switch dailyStats READ endpoints (9 endpoints) + dual-write (2 functions)
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

### 2026-06-18 (Session 4): Phase 1 — dailyStats Migration Complete
- Created `daily_stats` table on Cloud SQL (43 columns: aggregates, hour_00..hour_23, JSONB columns)
- Created PG functions: `daily_stats_merge_jsonb` (recursive deep merge), `daily_stats_merge_array` (array union)
- Created `dailyStatsFieldMapper.js` — handles dynamic Firestore keys (paymentMethod_*, ordersByType_*, orderTypeRevenue_*) → JSONB
- Created `dailyStatsRepo.js` — 8 methods: getById, getByIds, getByDate, getByDates, getSubRestaurantStats, atomicUpsert, upsertRevenueDiff, create
- Backfilled 851 docs (210 restaurants) with 0 errors
- Switched 9 READ endpoints to PG primary:
  - Analytics today, 7d/30d/all, daily-summary, sub-restaurant breakdown (index.js)
  - Books revenue, P&L, overview (index.js)
  - Super admin dashboard stats, orders/summary (routes/superAdmin.js)
- Added dual-write to 2 WRITE functions: updateDailyStats(), updateDailyStatsRevenueDiff()
- All Firestore dailyStats reads now have PG primary with Firestore fallback
- Next: Phase 2 — floors + tables migration

### 2026-06-18 (Session 5): Phase 2 — Floors + Tables Migration Complete
- Created `floors` + `tables` PG tables with FK CASCADE, 5 indexes
- Flattened Firestore subcollection `restaurants/{rid}/floors/{fid}/tables/{tid}` → 2 flat tables
- Created `floorsTablesFieldMapper.js` — simple camelCase↔snake_case, Firestore `order` → PG `sort_order`
- Created `floorsTablesRepo.js` — 25 methods including atomic `claimTable` (replaces Firestore transaction)
- Backfill running: 478 restaurants, ~4000+ tables, 0 errors
- Switched 3 READ endpoints to PG primary:
  - GET /api/floors/:restaurantId (2 queries vs N+1 Firestore reads)
  - GET /api/tables/:restaurantId (legacy)
  - Table lookup in order creation (findTableDirect + findTableByName)
- Added dual-write to 15 WRITE operations:
  - Table CRUD, bulk create, status update, reset-all
  - Floor CRUD, reorder, delete (CASCADE)
  - Table claim/release during order lifecycle (create, complete, cancel, delete)
  - Move order table swap (routes/moveOrder.js)
- Key design: `claimTable()` uses atomic `UPDATE...WHERE status='available' RETURNING *` — race-safe without transaction

### 2026-06-18 (Session 6): Phase 3 — Restaurants Migration Complete
- Created `restaurants` PG table (52 columns: simple fields + 17 JSONB columns)
- Created `restaurantsRepo.js` — 11 methods
- Backfilled 480 restaurant docs
- Integrated PG into `getCachedRestDoc()` as middle tier: Redis → PG → Firestore
- Added dual-write to 8 WRITE endpoints (restaurant CRUD, settings, code gen, Razorpay OAuth)

### 2026-06-19 (Session 7-8): Phase 4 — Inventory Ecosystem Migration Complete
- Created 7 PG tables: inventory, inventory_transactions, stock_batches, waste_entries, recipes, bar_bottles, bar_reconciliation
- Created `inventoryFieldMapper.js` — handles all 7 collections
- Created 6 repo files: inventoryRepo (11 methods), inventoryTransactionsRepo (7), stockBatchesRepo (12), wasteEntriesRepo (4), recipesRepo (7)
- Backfilled 24,937 docs across 7 collections (0 errors)
- Fixed `buildUpdate` bug in fieldMapper.js: extra_data was being replaced instead of merged (COALESCE merge)
- Switched 13 READ endpoints to PG primary with Firestore fallback
- Added 10 WRITE dual-writes (inventory CRUD, waste-entries, stock-audits, production-entries, recipe CRUD)
- Added 4 service-level dual-writes in inventoryService.js (deduct, restore, edit-restore, createDefaultRecipe)
- PG transactions replace Firestore batch writes for FIFO deduction/restoration
- All 5 high-cost collections now migrated (orders 33% + inventory 21% + restaurants 11% + floors/tables 10% + dailyStats 6% = 81% of reads)
