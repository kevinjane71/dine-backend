# PG Query-Parity Audit — Firestore (main) ↔ Postgres (pg-full-migration)

**Goal:** make `pg-full-migration` return the **same data** as `main` (Firestore) for every
read, so the Postgres branch is production-perfect. The route code is (largely) shared; the
divergence risk lives entirely in **`repos/pgAdapter.js`** translating Firestore query shapes
to SQL, and in the **per-collection field mappers**. (Timestamp *drift* between the two DBs is
out of scope for now — we only care that a query is **equivalent**, i.e. same rows, same order,
same field values given the same data.)

## Query surface (measured on pg-full-migration)
1,295 `.where()` · 191 range (`>= <= > <`) · 103 `orderBy` · 83 `in` · 18 dot-notation ·
5 `!=`/`not-in` · 1 `array-contains` · 1 `collectionGroup` · 11 transactions · 80 collections.

## The 9 divergence classes to check for every query
1. **Field → column mapping** — a camelCase field with no mapper entry silently falls into
   `extra_data`; a `WHERE`/`orderBy` on it then reads the wrong place (or fails).
2. **Range + orderBy** — Firestore needs the orderBy field == the inequality field and returns
   a specific order; PG must reproduce that order (incl. type: numeric vs text sort).
3. **`orderBy` semantics** — Firestore *excludes docs missing the field* and orders by type;
   pgAdapter adds `IS NOT NULL` + `id` tiebreak. Verify null-handling + tiebreak match.
4. **`in` / `not-in`** — `= ANY()` / `<> ALL()`; empty-array = zero rows (Firestore parity);
   >10-element `in` (Firestore caps at 30 now) — ensure no cap bug.
5. **`!=` / `== null`** — must be `IS [NOT] NULL`, never `= NULL` (always-empty bug).
6. **dot-notation JSONB** (`a.b`) — `col->>'b'` with correct cast for numeric/date/bool/`in`.
7. **`array-contains` / arrayUnion/Remove** — JSONB containment + set semantics.
8. **Aggregates & pagination** — `count()`, `offset()`, `limit()`, `startAfter()` (raw + snapshot
   cursor), `select()` — must not silently return 0 or drop scope on subcollections.
9. **Transactions & FieldValue** — `runTransaction` row-locking; increment/serverTimestamp/
   arrayUnion/delete sentinels on set/update; merge-set semantics.

## Methodology (per phase)
For each domain:
1. **Enumerate** every read endpoint + its queries (collection, where, orderBy, operators).
2. **Static check** each query against the 9 classes + the collection's mapper (is every
   filtered/ordered field a real mapped column or correctly JSONB-routed?).
3. **Differential test** — run the endpoint against **both** backends for a **controlled,
   identical** dataset and diff the JSON:
   - Stable domains (menu, restaurant/settings): the June PG backfill still matches Firestore
     for config that rarely changes → diff directly.
   - Transactional domains (orders/inventory): seed **one throwaway restaurant identically**
     into both DBs (script), then diff — isolates query bugs from data drift.
4. **Fix** in `pgAdapter.js` / the field-mapper; add the field/cast/operator handling.
5. **Re-test** the same endpoint until the diff is empty (modulo known timestamp drift).

Deliverable per phase: a checklist of endpoints with ✅/❌ + the pgAdapter/mapper fixes made.

## Phase 0 — Tooling (do first, ~½ day)
- `scripts/diff-endpoints.js` — hits a list of GET endpoints on `MAIN_URL` (Firestore/Vercel)
  and `PG_URL` (local server or GCP) with the same token+restaurant, deep-diffs the JSON
  (ignoring known timestamp fields), prints per-field mismatches.
- `scripts/seed-parity-restaurant.js` — writes an identical fixture restaurant (menu, tables,
  a few orders/inventory rows) into **both** Firestore and local PG for clean transactional diffs.
- A one-page **pgAdapter operator matrix** unit test (`__tests__/pgAdapter.parity.test.js`)
  that asserts each of the 9 classes against a known local dataset.

## Phase 1 — Billing (highest priority)
Collections: `orders`, `payments`, `dailyStats`, `offers`, `shifts`, `cashRegisters`,
`customers` (khata/wallet), `counters`.
Endpoints: `GET /api/orders/:rid` (+ filters: status, date-range, orderType, table),
`GET /api/kot/:rid`, `GET /api/orders/:rid/:orderId`, analytics/daily-summary/books,
shift/register reads, offers list, customer lookup by phone.
Hotspots: date-range + orderBy on `createdAt`; `status in [...]`; `paymentStatus` filters;
dailyStats packed-JSONB keys (`paymentMethod_cash.transactions`); counters increment.

## Phase 2 — Menu
Collections: `menus`, `menuItems`, `categories`, `restaurants.menu`.
Endpoints: `GET /api/menu/:rid`, `GET /api/menu-items/:rid`, category/variant reads, search.
Hotspots: `isVeg`/`isAvailable` boolean filters, `category ==`/`in`, `orderBy` sort order,
variants + pricingRules JSONB, sub_category mapping.

## Phase 3 — Inventory
Collections: `inventory`, `recipes`, `purchaseOrders`, `suppliers`, `stockBatches`, `wasteEntries`.
Endpoints: stock list, low-stock (`quantity <= threshold` range), recipe reads, PO by status/date,
batch FEFO ordering.
Hotspots: numeric range filters on `quantity`/`threshold`, `orderBy` expiry (date sort),
supplier/`in` filters.

## Phase 4 — Admin / Settings
Collections: `restaurants` (posSettings/taxSettings/printSettings/billingSettings), `staffUsers`,
`users`, `userRestaurants`, `roles`/pageAccess, `floors`, `tables`.
Endpoints: `GET /api/restaurants/:rid`, staff list, role/permission reads, floors+tables,
settings sub-objects.
Hotspots: deeply-nested settings JSONB round-trip (write→read identical), staff `role in [...]`,
floors composite PK `(id, restaurant_id)`, tables scoping.

## Ordering
Phase 0 → 1 → 2 → 3 → 4. Each phase: enumerate → static-check → diff-test → fix → re-test → commit.
Fixes land on `pg-full-migration` only. Re-run the phase's diff at the end to confirm parity.
