# dine-backend

## What This Is

Main REST API server for the DineOpen restaurant management platform. Handles POS operations, inventory, billing, AI features, payments, aggregator integrations, and more.

## Tech Stack

- **Runtime**: Node.js with Express 5
- **Database**: PostgreSQL on GCP Cloud SQL (primary, via pgAdapter) + Firebase Firestore (auth-coupled collections only) + Firebase Realtime Database
- **Cache**: Upstash Redis
- **Storage**: Google Cloud Storage (bucket: dine-menu-uploads)
- **Auth**: Firebase Admin + JWT (jsonwebtoken) + bcryptjs
- **Deployment**: GCP Cloud Run (pg-full-migration branch) + Vercel (serverless, Firestore branch)
- **Testing**: Jest

## Project Structure

```
index.js                  # Main server entry (monolithic, ~34K lines)
firebase.js               # Firestore + RTDB initialization
payment.js                # Razorpay subscription API
dodoPayment.js            # International payments
razorpayOAuth.js          # Restaurant payment OAuth
emailService.js           # Email via Nodemailer
invoiceEmailService.js    # Invoice email notifications

routes/                   # 43+ route modules
  aggregatorRoutes.js     # Talabat integration
  attendance.js           # Staff attendance
  aiInsights.js           # AI analytics
  bolna.js                # Phone agent
  centralKitchenRoutes.js # Multi-location kitchen
  delivery.js             # Delivery management
  dineai.js               # Voice/conversation AI
  feedback.js             # Customer feedback
  gstReports.js           # Tax reporting
  hotel.js                # Hotel features
  inventory.js            # Stock management
  ledger.js               # Accounting
  ownerDashboard.js       # Owner analytics
  parking.js              # Parking management
  payroll.js              # Employee payroll
  superAdmin.js           # Admin panel API
  whatsappOrdering.js     # WhatsApp orders
  bookings/               # Catering/venue booking
  ...

middleware/               # 18 middleware modules
  auth.js                 # JWT verification
  superAdminAuth.js       # Admin role check
  checkPermission.js      # Feature permissions
  orgAccess.js            # Organization isolation
  rateLimiter.js          # Rate limiting
  ...

services/                 # 29 service modules
  inventoryService.js     # Stock logic
  offerEngine.js          # Dynamic pricing
  deliveryService.js      # Delivery logistics
  firebaseRealtimeService.js  # Real-time updates
  fcmService.js           # Push notifications
  sadadService.js         # Saudi payments
  talabatService.js       # Talabat aggregator
  whatsappService.js      # WhatsApp API
  dineai/                 # AI voice system
    DineAIVoiceService.js
    DineAIToolExecutor.js # ~73KB, largest file
    DineAIConversationService.js
    DineAIKnowledgeService.js
    ...
  bolna/                  # Phone agent

utils/
  kvCache.js              # Redis cache layer
  firestoreOptimizer.js   # Query optimization
  timezone.js             # Timezone helpers
```

## Key Patterns

- **Monolithic index.js** (~34K lines) — routes are modular but bootstrapped centrally
- **Lazy initialization** for heavy deps (OpenAI, QRCode, Multer, GCS) to reduce Vercel cold starts
- **Service layer** separates business logic from route handlers
- **Firebase connection reuse** optimized for serverless (ignoreUndefinedProperties)
- **RAG system** for AI chatbots (OpenAI embeddings + Pinecone vector search)

## Database Collections (Firestore)

Core: users, restaurants, menus, menuItems, orders, payments, tables, floors
Inventory: inventory, recipes, purchaseOrders, suppliers, stockBatches, wasteEntries
Customers: customers, customerSegments, loyalty, feedbackResponses
Staff: staffUsers, attendance, leaveRequests, payrollConfig, payrollRuns
Accounting: chartOfAccounts, journalEntries, expenses, ledger, invoices
Enterprise: organizations, orgMenuTemplates, indentRequests, productionOrders
Hotel: hotelRooms, bookings, bookingVenues, spaceBookings
Parking: parkingConfigs, parkingZones, parkingSlots, parkingTickets
AI: automations, automationTemplates, aiUsage, coupons
Payments: subscriptions, dodoPayments

## Auth Flow

1. Login: Firebase Auth (phone/Google/Apple) or staff login (email+password)
2. JWT issued with role + restaurant context
3. All API requests: `Authorization: Bearer {token}`
4. Middleware stack: auth.js -> checkPermission.js -> orgAccess.js
5. Roles: owner, manager, staff, waiter, cashier, kitchen, delivery, customer, super-admin, sub-admin

## Environment

- Dev: `npm run dev` (port 3003)
- Production: Vercel auto-deploy from git
- Env files: `.env`, `.env.local`, `.env.production`
- Key env vars: `JWT_SECRET`, `FIREBASE_*`, `RAZORPAY_*`, `TWILIO_*`, `OPENAI_API_KEY`, `PINECONE_*`, `UPSTASH_*`

## Important Notes

- Backend supports multi-tenancy via restaurant ID scoping
- Talabat webhooks require signature verification (standardwebhooks)
- Real-time updates migrating from Pusher to Firebase RTDB
- AI features have token usage limits (aiUsageLimiter middleware)
- Firestore named database "dine" (not default) — staging uses "dine-staging"

## Firestore Cost Analysis (2026-06-16)

**Problem:** ₹500/day for 18 restaurants, 150 orders. ~20M reads/month. ~69,000 reads per restaurant per day.

### Profiler Findings (1-hour snapshot, production)

**Top collections by reads:**
| Collection | Reads | % |
|-----------|-------|---|
| orders | 407 | 33% |
| inventory | 257 | 21% |
| restaurants | 138 | 11% |
| tables | 128 | 10% |
| dailyStats | 77 | 6% |
| menuItems | 62 | 5% |
| others | ~172 | 14% |
| **Total** | **1,241** | |

**Top endpoints by reads:**
| Endpoint | Reads | Writes |
|----------|-------|--------|
| GET /api/orders/:restaurantId | 242 | 0 |
| POST /api/orders | 141 | 30 |
| GET /api/kot/:restaurantId | 154 | 0 |
| GET /api/floors/:restaurantId | 101 | 0 |
| GET /api/owner/dashboard | 97 | 0 |

**Writes:** 46 total in 1 hour (not a cost concern — reads dominate 97%)

### Key Insights
- `orders` collection is the #1 cost driver (33% of all reads)
- `GET /api/orders/:restaurantId` alone = 20% of all reads (polls frequently from frontend)
- Inventory reads are high (21%) — likely from stock checks during order placement
- `restaurants` collection read on almost every request (auth/config lookup — mitigated by Redis cache)
- Analytics/Books endpoints were optimized to use `dailyStats` (2026-06-16 session) — previously scanned raw orders

### DailyStats Optimization Done
- Enriched `updateDailyStats()` with: paymentMethod breakdown, categoryBreakdown, totalTax, totalDiscounts, totalRefunds, orderTypeRevenue
- Analytics "today" path now reads 1 dailyStats doc instead of scanning raw orders
- Daily-summary uses dailyStats for category/payment instead of raw order scan
- Books revenue/P&L/overview endpoints use dailyStats batch reads
- Expected daily read reduction: ~800K-1M reads/day saved

### Firestore Query Coupling (migration assessment)
- 153 unique collections, ~9,700 Firestore query calls across codebase
- 56+ files directly use `db` — no repository/data access layer
- 100+ uses of FieldValue.increment(), 21 transactions, 8+ batch writes
- Migration to PostgreSQL requires Phase 0 (abstraction layer) first
- Phase 1 (orders + dailyStats to PostgreSQL) would save 80% of cost

### Profiler Status
- **DISABLED** (2026-06-16) — was consuming too many Redis requests (28K in 30 min)
- Code still exists in `utils/firestoreProfiler.js` and admin UI in `dine-admin` Firestore tab
- To re-enable: uncomment profiler lines in index.js (lines ~133 and ~1480)

## PostgreSQL Migration (pg-full-migration branch)

### Overview

Full Firestore → PostgreSQL migration. When `DATABASE_URL` env var is set, ALL reads and writes go through PostgreSQL via the `pgAdapter` — a Firestore-compatible API layer that intercepts `db.collection().where().get()` calls and translates them to SQL. No application code changes needed.

**Motivation**: Firestore costs ₹500/day for 18 restaurants. PG on Cloud SQL costs ~₹100/day.

### Infrastructure

| Component | Details |
|-----------|---------|
| Cloud SQL instance | `dine-orders` at `34.14.155.43:5432` |
| Database | `dine`, user `dine_app` |
| Region | `asia-south1` (Mumbai) — same as Cloud Run |
| Cloud Run service | `dine-backend` → `https://dine-backend-1087929121342.asia-south1.run.app` |
| DATABASE_URL | `postgresql://dine_app:DineOrders2026Pg@34.14.155.43:5432/dine?ssl=true&sslmode=no-verify` |

### Architecture: pgAdapter (`repos/pgAdapter.js`)

The pgAdapter mimics the Firestore SDK API. It is wired in `firebase.js`:

```js
// firebase.js — when DATABASE_URL is set:
const REGISTRY = require('./repos/collectionRegistry');
const { createPgDb } = require('./repos/pgAdapter');
db = createPgDb(REGISTRY, firestoreDb);  // wraps all db.collection() calls
```

**Key classes:**
- `PgDocRef` — `.get()`, `.set()`, `.update()`, `.delete()`, `.collection()` (subcollections)
- `PgQuery` — `.where()`, `.orderBy()`, `.limit()`, `.offset()`, `.count()`, `.select()`, `.startAfter()`, `.get()`
- `PgCollectionRef` — `.doc()`, `.add()`, `.get()`, `.where()`, `.orderBy()`, etc.
- `PgScopedCollectionRef` — Handles subcollection patterns (e.g. `restaurants/{id}/floors`) with auto-scoping by parent doc ID + ancestor scope propagation
- `PgBatch` — Batch writes via PG transactions
- `PgTransaction` — `runTransaction()` support

**Key behaviors:**
- Unmapped collections fall back to Firestore automatically
- `FieldValue.increment()` → `col = COALESCE(col, 0) + N`
- `FieldValue.serverTimestamp()` → `NOW()`
- `FieldValue.arrayUnion()` → JSONB `||` operator
- `FieldValue.delete()` → `SET col = NULL`
- Dot-notation WHERE on JSONB columns → `col->>'field' = $1`
- Missing columns on `update()`/`set()` → auto-retry, overflow to `extra_data` JSONB
- NUMERIC type parser → `parseFloat()` (prevents string concatenation bugs)
- `doc.ref.parent.id` → returns collection name
- **Redis query cache** — transparent caching via Upstash Redis for cacheable collections (see below)

### Redis Cache Layer (pgAdapter)

The pgAdapter has a built-in transparent cache using Upstash Redis (`utils/kvCache.js`). Collections with `cacheTTL` in their registry config automatically cache reads and invalidate on writes.

**How it works:**
- Each cached table has a **version counter** (`pg:{table}:ver`) in Redis
- Doc reads cache as `pg:{table}:v{version}:{id}`
- Query reads cache as `pg:{table}:v{version}:q:{hash}` (MD5 of WHERE/ORDER/LIMIT)
- Any write (set/update/delete/add) bumps the version → all old cache keys auto-miss
- No manual cache invalidation needed — version bump handles everything

**Cached collections (set in `collectionRegistry.js`):**

| Collection | Table | TTL | Why |
|-----------|-------|-----|-----|
| restaurants | restaurants | 180s | Config read on every request |
| floors | floors | 60s | Layout rarely changes |
| tables | tables | 60s | Layout rarely changes (status writes bump version) |
| menus | menus | 120s | Menu structure changes infrequently |
| menuItems | menu_items | 120s | Item details change infrequently |
| staffUsers | staff_users | 120s | Staff list barely changes |
| offers | offers | 120s | Offer config changes infrequently |
| inventory | inventory | 30s | Stock changes on every order (short TTL) |

**NOT cached (by design):** orders, dailyStats, counters, payments — these change too frequently.

**To add caching to a new collection:** Add `cacheTTL: <seconds>` to its entry in `collectionRegistry.js`. That's it.

### Subcollection Routing

Firestore subcollections (e.g. `restaurants/{id}/floors/{floorId}/tables`) are flattened to PG tables with foreign key columns. The pgAdapter's `PgScopedCollectionRef` handles this:

```
db.collection('restaurants').doc(restaurantId).collection('floors')
  → PgScopedCollectionRef: SELECT * FROM floors WHERE restaurant_id = $1

db.collection('restaurants').doc(restaurantId).collection('floors').doc(floorId).collection('tables')
  → PgScopedCollectionRef with ancestor scopes:
    SELECT * FROM tables WHERE restaurant_id = $1 AND floor_id = $2
```

The scope chain propagates through `doc()` calls via `_scopeChain` on PgDocRef.

### File Structure

```
repos/
  pgAdapter.js              # Firestore-compatible API layer (core)
  pgClient.js               # PG connection pool
  collectionRegistry.js     # Maps 147+ Firestore collections → PG table configs
  queryBuilder.js           # SQL builders: buildInsert, buildUpdate, buildUpsert

  # Field mappers (per domain):
  fieldMapper.js            # orders
  floorsTablesFieldMapper.js
  inventoryFieldMapper.js
  restaurantsFieldMapper.js
  dailyStatsFieldMapper.js
  customersFieldMapper.js
  offersFieldMapper.js
  registerFieldMapper.js
  staffHrFieldMapper.js
  accountingFieldMapper.js
  hotelFieldMapper.js
  bookingsFieldMapper.js
  invoiceFieldMapper.js
  enterpriseFieldMapper.js
  aiFieldMapper.js
  systemMiscFieldMapper.js
  authMenuFieldMapper.js    # users, userRestaurants, staffCredentials, dine_user_data

  # Domain repos (used by some endpoints directly):
  ordersRepo.js
  counterRepo.js
  floorsTablesRepo.js
  ...

scripts/
  backfill-*-pg.js          # Firestore → PG backfill scripts (one per domain)
  create-*-tables.js        # DDL scripts
```

### Collections Still on Firestore

| Collection | Reason |
|-----------|--------|
| RTDB events/* | Real-time listeners (ephemeral) |
| `__profiler_init__` | Internal (not a real collection) |

All other collections (147+) are routed to PG when `DATABASE_URL` is set.

### Known Issues & Common Debugging Patterns

**1. "column X does not exist"**
A Firestore field maps to a PG column that doesn't exist yet. Fix:
```sql
ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <type> DEFAULT <default>;
```
Then add the field to the appropriate `*FieldMapper.js` FIELD_MAP.
The pgAdapter now auto-retries and puts unknown fields into `extra_data` JSONB, so this is non-fatal for `update()`/`set()` but still fails for `WHERE` clauses.

**2. "missing FROM-clause entry for table X"**
A dot-notation Firestore field (e.g. `staffInfo.userId`) is being used in a WHERE clause on a JSONB column. The pgAdapter handles this by converting to `col->>'key'` syntax. If a new dot-notation pattern appears, check that the top-level field is in the JSONB_COLUMNS set.

**3. Empty results from subcollections**
If `db.collection('restaurants').doc(id).collection('floors').get()` returns empty, check:
- Is the collection name in `collectionRegistry.js`?
- Does the PG table have data for this `restaurant_id`?
- Is the ancestor scope propagating correctly?

**4. NUMERIC fields returned as strings**
Fixed globally with `pg.types.setTypeParser(1700, parseFloat)` in pgAdapter.js. If a new numeric type appears, add its OID parser.

**5. Dual-write cleanup removed critical code**
The dual-write removal (Phase 11) was aggressive and removed some Firestore read paths that were the ONLY code loading data (not just dual-write fire-and-forget). Symptoms: `undefined` variables, empty arrays, always-false conditions. Check git history:
```bash
git diff HEAD~1 -- index.js | grep -B5 "^-.*floorsTablesRepo\|^-.*ordersRepo\|^-.*usePg"
```
Key areas that were restored:
- `GET /api/floors/:restaurantId` — floor+table loading loop
- `GET /api/kot/:restaurantId` — order fetching query
- `POST /api/orders` — table finding + atomic claim logic

### Deployment

```bash
# Build and deploy to Cloud Run:
gcloud builds submit --tag gcr.io/ascendant-idea-443107-f8/dine-backend --project ascendant-idea-443107-f8 --quiet
gcloud run deploy dine-backend --image gcr.io/ascendant-idea-443107-f8/dine-backend --region asia-south1 --project ascendant-idea-443107-f8 --quiet

# Check logs:
gcloud run services logs read dine-backend --region asia-south1 --limit 100

# Current revision: dine-backend-00011-hsk (as of 2026-06-23)
# Env vars are set via --env-vars-file pointing to .env.local (44 vars)
```

### Testing the PG branch locally

```bash
# Frontend (localhost:3002) → Cloud Run PG backend:
# In dine-frontend/.env.local:
NEXT_PUBLIC_API_URL=https://dine-backend-1087929121342.asia-south1.run.app

# To switch back to Firestore/Vercel production:
NEXT_PUBLIC_API_URL=https://dine-backend-lake.vercel.app
```

### Backfill

All backfill scripts are in `scripts/backfill-*-pg.js`. They support:
- `--dry-run` — count without writing
- `--upsert` — update existing rows
- `--restaurant <id>` — single restaurant

To re-backfill all orders (e.g. after production creates new ones):
```bash
node scripts/backfill-orders-pg.js --upsert
```

## Session Log

### 2026-05-28: Initial CLAUDE.md created
- Documented full architecture, tech stack, patterns, and DB schema

### 2026-06-16: Firestore cost optimization + profiler
- Enriched dailyStats with payment/category/tax fields
- Updated analytics, daily-summary, Books revenue/P&L/overview to use dailyStats
- Built Firestore read/write profiler with per-endpoint tracking (AsyncLocalStorage)
- Added Firestore tab to dine-admin dashboard
- Profiler disabled after gathering data — Redis quota concern
- Documented findings above for future reference

### 2026-06-23: Full PG migration — pgAdapter, Cloud Run deployment, bug fixes

**pgAdapter infrastructure built:**
- `repos/pgAdapter.js` — Firestore-compatible API backed by PG (PgDocRef, PgQuery, PgCollectionRef, PgScopedCollectionRef, PgBatch, PgTransaction)
- `repos/collectionRegistry.js` — 147+ collection mappings
- `repos/authMenuFieldMapper.js` — 6 collections: menus, menuItems, users→app_users, userRestaurants, staffCredentials, dine_user_data
- `firebase.js` wired: when `DATABASE_URL` set, `db = createPgDb(REGISTRY, firestoreDb)`

**Dual-write removal:**
- Removed 526 fire-and-forget PG dual-write calls across 59 files
- Some removals were too aggressive — restored critical Firestore read paths for:
  - GET /api/floors (floor+table loading)
  - GET /api/kot (order fetching)
  - POST /api/orders (table finding + atomic claim)

**Cloud Run deployment:**
- 11 revisions deployed iteratively fixing issues
- 44 env vars from .env.local
- Dockerfile: node:20-slim, npm ci --production, port 3003

**PG schema fixes (columns added during testing):**
- `app_users`: status, language, default_restaurant_id, restaurant_id
- `restaurants`: organization_id
- `orders`: item_count
- `saved_carts`: name, type, is_active, customer_info, order_type, table_number, payment_method, created_by

**pgAdapter fixes applied:**
- `getAll()` method for batch doc reads
- `select()` no-op for API compat
- `offset()` + `count()` methods for pagination
- `parent` getter on PgDocRef (returns `{ id: collectionName }`)
- Duplicate `updated_at` prevention in update()
- Missing-column resilience: auto-retry with overflow to `extra_data` JSONB
- NUMERIC/BIGINT type parsers (prevent string concatenation bugs)
- JSONB dot-notation in WHERE clauses (`staffInfo.userId` → `staff_info->>'userId'`)
- Subcollection routing via PgScopedCollectionRef with ancestor scope propagation

### 2026-07-12: Pre-cutover audit + full adapter/registry fix (merged main)

**Merged main → pg-full-migration** (9 commits): covers/totalCovers daily stats, timezone-aware offer schedules, WhatsApp webhook dedup by messageId, chatgptUsageLimiter FieldValue fix, KOT status RTDB notify, CSV parser upgrades (isVeg/variants-JSON/description + .txt pre-parse), superAdminDisabledPages, super-admin WhatsApp dedup, offline-sync fallback for deleted menu items.

**pgAdapter core fixes (repos/pgAdapter.js, queryBuilder.js, pgClient.js):**
- `set()`/`add()` now translate FieldValue sentinels (increment/serverTimestamp/arrayUnion/arrayRemove/delete) — previously silently dropped, which zeroed ALL dailyStats accumulation. Merge-set with sentinels = UPDATE-first, INSERT-resolved-row on miss (race-safe via ON CONFLICT DO NOTHING)
- Timestamp revival on every read: timestamptz Dates and JSONB `{_seconds,_nanoseconds}` blobs → real Firestore Timestamps (`.toDate()` works again; OTP login, KOT, shift close-out fixed). Plain ISO strings intentionally NOT converted
- `where(f,'!=',null)` → `IS NOT NULL` (was `!= NULL` = always empty); same for `'=='`
- `doc()` with no args auto-generates an ID (10+ create flows crashed with NULL id)
- `db.collectionGroup(name)` implemented (mapped → flat-table query; unmapped → Firestore fallback) — fixes SADAD webhook TypeError
- `update()`: throws NOT_FOUND (code 5) on missing doc like Firestore; dot-path JSONB writes create intermediate objects, support sentinels at the leaf, and paths are parameterized (`$n::text[]`); extra_data updates MERGE (`||`) instead of replacing; missing-column retry routes fields into extra_data as JSONB-path writes (sentinel semantics preserved), capped depth, no infinite recursion
- arrayUnion dedupes (Firestore set semantics); arrayRemove single-pass
- Cursors: `startAfter(rawValue...)` supported; snapshot cursors use row-value tuple comparison with doc-id tiebreak; orderBy adds `IS NOT NULL` (Firestore excludes docs missing the field) + `id` tiebreak in ORDER BY
- Transactions: `SELECT ... FOR UPDATE` row locking; `tx.get(query)` runs on the tx connection; ROLLBACK failures poison-release the client
- count() propagates errors (was silently returning 0); getAll() rejects on error; scoped subcollections no longer leak scope on count/offset/select/startAfter
- JSONB dot-path WHERE: numeric/date casts, `in`/`not-in`, booleans, null — no more lexicographic text compares
- Per-collection `resolveKeyPath` hook (dailyStats): dynamic keys like `paymentMethod_cash.transactions` land in packed `payment_methods` JSONB
- pgClient: statement_timeout (30s default), connect timeout 10s, env knobs PG_STATEMENT_TIMEOUT_MS/PG_CONNECT_TIMEOUT_MS

**Registry/mappers:** 153/158 entries now carry real fieldMaps (was ~54); booking_venues duplicate key resolved (canonical: booking_venues + hotelBooking mapper); `menu` alias → menu_items (14 AI/RAG legacy subcollection readers now read live PG data); new mapped columns: restaurants.aggregator_config, orders.delivery_status/delivery_assigned_at, feedback_forms.distribution, rest_bookings.venue, owner_preferences.email_enabled/active_report_hours_utc, daily_stats.total_covers, app_users.email_otp/email_otp_expiry, purchase_orders.expected_delivery_date/received_at, menu_items.sub_category.

**⚠️ scripts/add-cutover-columns.sql MUST run on Cloud SQL before deploying this revision** (adds columns + migrates values out of extra_data). Cutover procedure: docs/pg-cutover-runbook.md. Deploy script fixed: switch-backend.sh now uses --update-env-vars (--set-env-vars wiped all 44 env vars).
