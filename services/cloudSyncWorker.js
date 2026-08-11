/**
 * cloudSyncWorker — keeps the on-prem local server and the cloud (main) DB in sync so
 * the SAME restaurant can also be used from the web version. Runs only on the local
 * server. Both sides are Postgres with the same schema, so this is generic, idempotent
 * ROW replication (no re-coded logic):
 *
 *   SELECT * FROM t WHERE updated_at > <watermark> ORDER BY updated_at LIMIT N
 *   INSERT ... ON CONFLICT (id) DO UPDATE            (idempotent by UUID)
 *
 * SPLIT AUTHORITY (avoids conflicts — a table only ever flows ONE way):
 *   • UP   (local → cloud): transactions — orders, payments, daily_stats, shifts…
 *                            local is the source of truth while offline.
 *   • DOWN (cloud → local): catalog/config — menu, prices, offers, staff, settings…
 *                            cloud is the source of truth (owner edits on the web).
 *
 * SYNC_MODE flag (set per site on the local server):
 *   • off | offline  — complete island, no cloud sync at all.
 *   • periodic       — auto every CLOUD_SYNC_INTERVAL_MS when the cloud is reachable.
 *   • manual         — only when POST /api/local-server/sync-now is called.
 *
 * Env: CLOUD_DATABASE_URL (the cloud/main DB, ≠ local DATABASE_URL),
 *      CLOUD_SYNC_TABLES (up), CLOUD_SYNC_DOWN_TABLES (down), CLOUD_SYNC_INTERVAL_MS,
 *      CLOUD_SYNC_BATCH. Back-compat: CLOUD_SYNC_ENABLED=true ⇒ mode 'periodic'.
 */

const { Pool } = require('pg');

const INTERVAL_MS = parseInt(process.env.CLOUD_SYNC_INTERVAL_MS, 10) || 45000;
const BATCH = parseInt(process.env.CLOUD_SYNC_BATCH, 10) || 500;

// FULL restaurant sync, split-authority (bidirectional overall, conflict-free):
//   UP (local → cloud): transactions + things created/mutated offline (local is truth offline).
//   DOWN (cloud → local): catalog/config the owner edits on the web (cloud is truth).
// Missing tables are skipped gracefully, so listing extras is safe. Override per-site via env.
const UP_TABLES = (process.env.CLOUD_SYNC_TABLES ||
  // Everything the shop GENERATES locally must flow UP so the cloud is complete. These are almost
  // all RECORDS (globally-unique id → merge = UNION by id, never a double-count; edits resolve LWW
  // on updated_at) plus a few LOCAL-authoritative aggregates (shifts/cash/inventory.current_stock/
  // bar_bottles) where the terminal is the sole writer so there is no clobber.
  //   NOTE ON TABLE NAMES: this worker replicates by RAW PG TABLE NAME, not by Firestore collection
  //   name. `payments`→`pos_payments`, `customer_segments`→`customer_groups` etc. Using a collection
  //   name that has no matching table = a silent no-op (the table is "missing at source").
  [
    // Orders / billing / payments (pos_payments = the real payments table; pos_invoices = tax bills)
    'orders', 'pos_payments', 'pos_invoices', 'daily_stats', 'shifts', 'cash_registers', 'discount_approvals',
    // Customers / CRM / feedback (customer_offer_usage = per-customer offer-cap counter, UP-authoritative)
    'customers', 'customer_offer_usage', 'feedback_responses', 'waitlist',
    // Layout / bookings
    'floors', 'tables', 'rest_bookings',
    // Inventory / supply chain / bar — inventory FIRST (parent) then its ledger/movements.
    // inventory_transactions = the stock LEDGER (lets the cloud audit/recompute stock).
    // bar_bottles = bar stock (running counters, local-authoritative, UP-only whole-row like shifts).
    'inventory', 'inventory_transactions', 'stock_audits', 'stock_oversell_log', 'waste_entries',
    'stock_batches', 'stock_transfers', 'goods_receipt_notes', 'supplier_invoices', 'supplier_returns',
    'supplier_performance', 'purchase_orders', 'purchase_requisitions', 'production_entries',
    'bar_bottles', 'bar_reconciliation',
    // Staff / HR / payroll (payroll_runs before pay_slips; staff_availability/credentials have NO
    // restaurant_id so they are UP-ONLY — never DOWN, or a single-tenant device would pull every
    // restaurant's rows). leave_balances is a running balance but the shop is authoritative → UP.
    'attendance', 'leave_requests', 'leave_balances', 'payroll_runs', 'pay_slips',
    'staff_shifts', 'staff_availability', 'staff_credentials',
    // Accounting (journal_entries = manual GL postings; account refs are by CODE so id-merge is safe)
    'expenses', 'journal_entries',
    // Menu (column-scoped to restaurants.menu only — see SYNC_ONLY_COLS)
    'restaurants',
  ].join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
// The dine MENU is embedded in restaurants.menu (jsonb), not a separate table, so we two-way it
// via a COLUMN-SCOPED sync of the restaurants row (only the `menu` column — see SYNC_ONLY_COLS).
// Menu edits are admin/owner permission-gated, so churn is low and conflicts are rare.
//
// orders + payments are in BOTH up and down → true two-way: orders placed on the web (or on
// another terminal) flow DOWN into this app, and orders placed here flow UP. Safe because each
// order has a globally-unique id, so merge = UNION by id (never a double-count); edits resolve
// last-write-wins by updated_at. (daily_stats stays UP-only — it's an aggregate, not row-keyed,
// so two-waying it would clobber; the cloud recomputes its own.)
// rest_bookings is two-way. floors/tables come DOWN (structure) but their live occupancy columns
// are preserved locally (DOWN_PRESERVE_COLS) while still flowing UP to the cloud.
const DOWN_TABLES = (process.env.CLOUD_SYNC_DOWN_TABLES ||
  // Owner-authoritative CONFIG the shop must receive from the web. DOWN is SCOPED to this one
  // restaurant (SCOPE_RID) so every table here MUST have a restaurant_id column, or it would drag
  // other tenants' rows onto this device — DO NOT add rid-less tables (staff_availability,
  // customer_offer_usage, staff_credentials, distribution_plans/indent_requests/production_orders).
  //   FIXED PHANTOMS: `payments`→`pos_payments`, `customer_segments`→`customer_groups`. Removed
  //   `tax_groups` (no such table — tax lives in restaurants.tax_settings, now synced via
  //   DOWN_ONLY_COLS) and `discount_settings` (dead table — real config is
  //   restaurants.discount_approval_settings, also via DOWN_ONLY_COLS).
  [
    'restaurants', 'orders', 'pos_payments', 'staff_users', 'floors', 'tables', 'rest_bookings',
    'offers', 'recipes', 'suppliers', 'inventory', 'customers', 'coupons', 'customer_groups',
    // owner config that must reach the shop so offline payroll/leave/feedback/scheduling work:
    'payroll_config', 'leave_config', 'inventory_categories', 'restaurant_shift_settings', 'feedback_forms',
    // expenses two-way (web-added expenses appear in the terminal Books; RECORD → union by id)
    'expenses',
  ].join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
// One-restaurant device: DOWN pulls ONLY this restaurant's rows from the shared cloud DB.
const SCOPE_RID = (process.env.SYNC_RESTAURANT_ID || '').trim() || null;

function resolveMode() {
  let m = (process.env.SYNC_MODE || '').toLowerCase().trim();
  if (!m) m = process.env.CLOUD_SYNC_ENABLED === 'true' ? 'periodic' : 'off';
  if (m === 'offline') m = 'off';
  return ['off', 'periodic', 'manual'].includes(m) ? m : 'off';
}

let localPool = null;
let cloudPool = null;
let timer = null;
let cycleRunning = false;
let cyclesCompleted = 0;   // how many full sync cycles have finished (UI uses this to detect
let lastCycleAt = null;    // "first sync done" and to show a live progress/status pill)
let mode = 'off';

async function getColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows;
}

// Real primary-key columns for a table (handles composite PKs like floors=(id,restaurant_id)),
// so ON CONFLICT targets the actual PK instead of assuming (id).
const _pkCache = new Map();
async function getPk(client, table) {
  if (_pkCache.has(table)) return _pkCache.get(table);
  let pk = ['id'];
  try {
    const r = await client.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`, [table]);
    if (r.rows.length) pk = r.rows.map((x) => x.attname);
  } catch (_) {}
  _pkCache.set(table, pk);
  return pk;
}

async function ensureWatermarkTable() {
  await localPool.query(`
    CREATE TABLE IF NOT EXISTS sync_watermark (
      key text PRIMARY KEY,
      last_updated_at timestamptz,
      last_run timestamptz,
      last_error text,
      rows_synced bigint DEFAULT 0
    )`);
}

// Make the shared updated_at trigger PRESERVE an explicitly-supplied timestamp (which sync
// writes always do) and only auto-bump when the caller DIDN'T change it. Without this, the
// BEFORE UPDATE trigger rewrites updated_at=now() on every sync write, so a just-synced row
// looks "new" forever and orders ping-pong up↔local every cycle. Local DB only, and fully
// backward-compatible: a normal app UPDATE (no explicit updated_at) still bumps to now().
async function ensureIdempotentUpdatedAt() {
  try {
    await localPool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
      BEGIN
        IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
          NEW.updated_at := now();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
  } catch (e) {
    console.warn('cloudSync: could not make updated_at trigger idempotent:', e.message);
  }
}

async function getWatermark(key) {
  const r = await localPool.query('SELECT last_updated_at FROM sync_watermark WHERE key = $1', [key]);
  return (r.rows[0] && r.rows[0].last_updated_at) || new Date(0);
}
async function setWatermark(key, ts, err, addRows) {
  await localPool.query(
    `INSERT INTO sync_watermark (key, last_updated_at, last_run, last_error, rows_synced)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       last_updated_at = EXCLUDED.last_updated_at, last_run = now(),
       last_error = EXCLUDED.last_error, rows_synced = sync_watermark.rows_synced + EXCLUDED.rows_synced`,
    [key, ts, err || null, addRows || 0]);
}

// jsonb/json values come back as objects/arrays; stringify so pg sends JSON (not a PG array literal).
function coerce(value, dataType) {
  if (value == null) return value;
  if ((dataType === 'jsonb' || dataType === 'json') && typeof value === 'object') return JSON.stringify(value);
  return value;
}

// DOWN-sync live-state protection: these columns are LOCAL-authoritative operational state that
// the local POS mutates constantly (occupy/free/reset a table, deduct stock). A cloud→local DOWN
// upsert must NOT overwrite them, or a stale cloud row (cross-clock last-write-wins) would re-occupy
// a just-reset table or reset stock back up (oversell). We still INSERT them for brand-new rows
// (so a new table/item arrives with its state), but never overwrite them on an existing row.
const DOWN_PRESERVE_COLS = {
  tables: ['status', 'current_order_id'],
  inventory: ['current_stock', 'stock_quantity'],
  // Customer loyalty/wallet/spend are running counters that ACCRUE at checkout on the shop
  // terminal (points earned/redeemed, khata, wallet, totals). They must not be overwritten by a
  // stale cloud copy on DOWN — the local value is authoritative and flows UP (customers is a
  // two-way table, so the profile fields still sync both ways; only these counters are preserved).
  customers: [
    'loyalty_points', 'lifetime_points', 'loyalty_tier', 'loyalty_transactions',
    'total_spent', 'total_orders', 'outstanding_balance', 'wallet_balance', 'wallet_history',
  ],
  // offers/coupons are owner CONFIG (flow DOWN) but their redemption counters ACCRUE at billing on
  // the terminal. A whole-row DOWN of an owner web-edit would reset the locally-counted usage → the
  // per-offer/coupon cap stops being enforced. Preserve the counter locally; it still flows UP via
  // customer_offer_usage (the per-customer ledger). (offers/coupons themselves stay OUT of UP so the
  // whole-row usage_count is never pushed up and double-counted.)
  offers: ['usage_count'],
  coupons: ['used_count'],
  // feedback_forms is CONFIG (flow DOWN) but response_count is incremented locally as diners submit;
  // don't let a form edit on the web reset it.
  feedback_forms: ['response_count'],
};

// Column-scoped tables: sync ONLY these columns (via a targeted UPDATE), never the rest of the
// row. The dine menu is embedded in restaurants.menu, so we two-way just that jsonb column and
// leave the other ~54 operational/config columns untouched on both sides — a menu edit propagates
// without any risk of clobbering settings. The row always exists (provisioned), so UPDATE-only is
// safe (no INSERT that would fail on the NOT NULL columns we deliberately skip).
const SYNC_ONLY_COLS = {
  restaurants: ['menu'],
};

// UP-direction-only column scope. Inventory stock is LOCAL-authoritative (the shop deducts it on
// every sale), so UP pushes ONLY current_stock to the cloud — never the config columns, which the
// owner edits on the cloud and which flow DOWN. Combined with DOWN_PRESERVE_COLS.inventory (DOWN
// leaves current_stock alone), this gives a clean split with no clobber in either direction:
// stock flows up, config flows down. (Restock is therefore done on the terminal — the authority.)
const UP_ONLY_COLS = {
  inventory: ['current_stock'],
};

// DOWN-direction-only column scope. The restaurant config (tax rates, prices, currency, billing/
// order rules, discount-approval policy, aggregator keys) is embedded as jsonb columns on the
// `restaurants` row and is OWNER-authoritative — edited on the web. Without this, only `menu` synced
// (SYNC_ONLY_COLS) and an owner who changed the TAX RATE or PRICES on the web produced WRONG offline
// bills. These columns flow DOWN (cloud→shop) only; they are NOT pushed UP, so terminal-local device
// settings can't overwrite the owner's config. Terminal-owned device config (kot/print/pos settings)
// is deliberately EXCLUDED so a DOWN never clobbers this device's printer/KOT setup.
// Combined with SYNC_ONLY_COLS.restaurants=['menu'] the effective column scope per direction is:
//   UP   → [menu]                        (menu edits made on the terminal reach the cloud)
//   DOWN → [menu, ...DOWN_ONLY_COLS]      (owner menu + config edits reach the shop)
// Both use the column-scoped UPDATE path (existing row, strictly-newer guard) — never an INSERT.
const DOWN_ONLY_COLS = {
  restaurants: [
    'tax_settings', 'pricing_settings', 'currency_settings', 'billing_settings', 'order_settings',
    'discount_approval_settings', 'booking_settings', 'feedback_settings', 'customer_app_settings',
    'aggregator_config',
  ],
};

// Per-row failure counter so a row that throws is RETRIED (not silently skipped by an advancing
// watermark) but also can't wedge a table forever — after MAX_ROW_RETRIES it is loudly dead-lettered.
const _rowFailCounts = new Map();
const MAX_ROW_RETRIES = 5;

// Replicate one table from src → dst. `key` namespaces the watermark (direction:table).
// scopeRid (optional): restrict to ONE restaurant. CRITICAL for DOWN (cloud→local) — the
// cloud holds every restaurant's rows, and a single-restaurant device must pull ONLY its
// own. Applied only when the table actually has a restaurant_id column (skips globals).
async function replicate(src, dst, table, key, scopeRid = null) {
  const srcCols = await getColumns(src, table);
  if (!srcCols.length) return { table, key, skipped: 'missing at source' };
  const srcNames = srcCols.map((c) => c.column_name);
  if (!srcNames.includes('id') || !srcNames.includes('updated_at')) return { table, key, skipped: 'no id/updated_at' };

  const dstNames = new Set((await getColumns(dst, table)).map((c) => c.column_name));
  if (!dstNames.size) return { table, key, skipped: 'missing at destination' };

  const cols = srcCols.filter((c) => dstNames.has(c.column_name));
  const typeOf = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  const pk = await getPk(dst, table);            // real PK (composite-aware) at the destination
  const isDown = key.startsWith('down:');

  let names, sql;
  // Column-scoped columns for this table + direction: SYNC_ONLY_COLS applies both ways;
  // UP_ONLY_COLS applies only when pushing UP (local → cloud); DOWN_ONLY_COLS only when pulling DOWN.
  // Non-existent columns are filtered out here, so listing a column a device lacks is safe.
  const onlyCols = [
    ...(SYNC_ONLY_COLS[table] || []),
    ...(!isDown ? (UP_ONLY_COLS[table] || []) : []),
    ...(isDown ? (DOWN_ONLY_COLS[table] || []) : []),
  ].filter((c, i, a) => a.indexOf(c) === i && dstNames.has(c) && srcNames.includes(c));
  if (onlyCols.length) {
    // Column-scoped: UPDATE only the allowlisted columns (+ advance updated_at) on the existing
    // row when the incoming is strictly newer. No INSERT — the row is provisioned, and we must not
    // touch the columns we skip. Param order == `names` order below.
    names = [...onlyCols, 'updated_at', ...pk];
    const setClause = onlyCols.map((c, i) => `"${c}"=$${i + 1}`).join(', ');
    const uaParam = onlyCols.length + 1;                 // $N for updated_at (SET + guard)
    const pkClause = pk.map((c, i) => `"${c}"=$${onlyCols.length + 2 + i}`).join(' AND ');
    sql = `UPDATE "${table}" SET ${setClause}, "updated_at"=$${uaParam} WHERE ${pkClause} AND "${table}".updated_at < $${uaParam}`;
  } else {
    // On DOWN (cloud→local), never OVERWRITE local live-state columns on an existing row — they are
    // owned by the local POS. They're still INSERTed for brand-new rows, just excluded from the
    // ON CONFLICT DO UPDATE SET, so a stale cloud row can't re-occupy a table or reset stock.
    const preserveCols = isDown ? (DOWN_PRESERVE_COLS[table] || []) : [];
    names = cols.map((c) => c.column_name);
    const setCols = names.filter((c) => !pk.includes(c) && !preserveCols.includes(c));
    const ph = names.map((_, i) => `$${i + 1}`).join(',');
    const conflictTgt = pk.map((c) => `"${c}"`).join(',');
    const upd = setCols.length ? setCols.map((c) => `"${c}"=EXCLUDED."${c}"`).join(',') : `"${pk[0]}"=EXCLUDED."${pk[0]}"`;
    const quotedIns = names.map((c) => `"${c}"`).join(',');
    // Idempotency guard: only overwrite when the incoming row is STRICTLY NEWER. An already-
    // in-sync row (equal updated_at) is skipped entirely — no write, no trigger fire, no
    // timestamp bump — so the watermark advances past it and it is never re-synced. This is
    // what stops orders (bidirectional) from ping-ponging up↔down every cycle.
    sql = `INSERT INTO "${table}" (${quotedIns}) VALUES (${ph}) ON CONFLICT (${conflictTgt}) DO UPDATE SET ${upd} WHERE "${table}".updated_at < EXCLUDED.updated_at`;
  }
  const quoted = names.map((c) => `"${c}"`).join(',');   // SELECT column list (both paths)

  // The restaurants table is keyed by `id` (= the restaurant id); every other table scopes
  // by `restaurant_id`. Only scope when the column exists (skips truly-global tables).
  const scopeCol = table === 'restaurants' ? 'id' : 'restaurant_id';
  const scoped = scopeRid && srcNames.includes(scopeCol);
  const scopeSql = scoped ? ` AND "${scopeCol}" = $2` : '';

  // SAFETY: a DOWN sync MUST be restaurant-scoped — the cloud holds every tenant's rows. If a DOWN
  // table lacks the scope column, pulling it unscoped would drag EVERY restaurant's data onto this
  // single-restaurant device. Skip it loudly rather than leak. (All configured DOWN tables have
  // restaurant_id or are `restaurants`; this guards against future misconfiguration.)
  if (isDown && scopeRid && !scoped) {
    return { table, key, skipped: 'DOWN not restaurant-scoped (no scope column) — refused to avoid tenant leak' };
  }

  let wm = await getWatermark(key);
  let lastGood = wm;
  let total = 0, failed = 0, deadLettered = 0;
  let lastErr = null;
  let stopAdvancing = false;   // once a row fails (and hasn't exhausted retries), don't advance the
                               // watermark past it — so it (and everything after) retries next cycle
  for (;;) {
    const res = await src.query(
      `SELECT ${quoted} FROM "${table}" WHERE updated_at > $1${scopeSql} ORDER BY updated_at ASC LIMIT ${BATCH}`,
      scoped ? [wm, scopeRid] : [wm]);
    if (!res.rows.length) break;
    let batch = 0;
    for (const row of res.rows) {
      // Row identity for retry counting — include updated_at so a row that CHANGES gets a fresh count.
      const stamp = row.updated_at && row.updated_at.getTime ? row.updated_at.getTime() : row.updated_at;
      const fkey = `${key}:${row.id}:${stamp}`;
      let resolved = false; // did we either write it or give up on it (safe to advance past)?
      try {
        await dst.query(sql, names.map((c) => coerce(row[c], typeOf[c])));
        batch++; total++; resolved = true;
        _rowFailCounts.delete(fkey);
      } catch (rowErr) {
        failed++; lastErr = `${row.id}: ${rowErr.message}`;
        const n = (_rowFailCounts.get(fkey) || 0) + 1;
        _rowFailCounts.set(fkey, n);
        if (n >= MAX_ROW_RETRIES) {
          // Give up so one poison row can't wedge the whole table forever — but LOUDLY (not silent).
          console.error(`[cloudSync] DEAD-LETTER after ${n} attempts, skipping row ${key} id=${row.id}: ${rowErr.message}`);
          _rowFailCounts.delete(fkey);
          deadLettered++; resolved = true;
        } else {
          // Retry this row (and everything after it) on the next cycle — do NOT skip past it.
          stopAdvancing = true;
        }
      }
      // Advance the watermark only across a contiguous run of resolved rows. The moment an
      // unresolved failure appears, freeze the cursor so nothing after it is skipped.
      if (!stopAdvancing && resolved && row.updated_at && row.updated_at > lastGood) lastGood = row.updated_at;
      if (stopAdvancing) break;
    }
    wm = lastGood;
    await setWatermark(key, wm, lastErr, batch); // advance watermark past the contiguous resolved rows
    if (stopAdvancing) break;                    // retry the frozen row next cycle
    if (res.rows.length < BATCH) break;
  }
  return { table, key, synced: total, ...(failed ? { failed, error: lastErr } : {}), ...(deadLettered ? { deadLettered } : {}) };
}

async function cloudReachable() {
  try { await cloudPool.query('SELECT 1'); return true; } catch (_) { return false; }
}

async function runCycle() {
  if (cycleRunning || !localPool || !cloudPool) return { skipped: 'not-ready' };
  cycleRunning = true;
  const summary = { up: 0, down: 0, tables: [], reachable: false, ordersMoved: 0 };
  const ORDER_TABLES = new Set(['orders', 'payments']);
  try {
    if (!(await cloudReachable())) return summary;
    summary.reachable = true;
    for (const t of UP_TABLES) {
      const r = await replicate(localPool, cloudPool, t, `up:${t}`);
      if (r.synced) { summary.up += r.synced; if (ORDER_TABLES.has(t)) summary.ordersMoved += r.synced; }
      if (r.error || r.skipped) summary.tables.push(r);
    }
    for (const t of DOWN_TABLES) {
      const r = await replicate(cloudPool, localPool, t, `down:${t}`, SCOPE_RID);
      if (r.synced) { summary.down += r.synced; if (ORDER_TABLES.has(t)) summary.ordersMoved += r.synced; }
      if (r.error || r.skipped) summary.tables.push(r);
    }
    if (summary.up || summary.down) console.log(`☁️  cloud-sync: ↑${summary.up} ↓${summary.down} rows`);
    // Recompute derived aggregates (revenue/daily_stats) from the synced orders — copied-in
    // rows don't trigger the per-order increment, so the host rebuilds stats from orders.
    if (summary.ordersMoved && onOrdersChanged) {
      try { await onOrdersChanged(summary); } catch (e) { console.warn('☁️  onOrdersChanged hook error:', e.message); }
    }
  } catch (e) {
    console.warn('☁️  cloud-sync cycle error:', e.message);
  } finally {
    cycleRunning = false;
    if (summary.reachable) { cyclesCompleted += 1; lastCycleAt = new Date().toISOString(); }
  }
  return summary;
}

function initPools() {
  const cloudUrl = process.env.CLOUD_DATABASE_URL;
  const localUrl = process.env.DATABASE_URL;
  if (!cloudUrl || !localUrl || cloudUrl === localUrl) return false;
  localPool = new Pool({ connectionString: localUrl, max: 4 });
  cloudPool = new Pool({ connectionString: cloudUrl, max: 4, connectionTimeoutMillis: 8000, statement_timeout: 20000 });
  return true;
}

// Optional hook: called after a cycle that moved order rows, so the host can RECOMPUTE
// derived aggregates (daily_stats/revenue) from the now-synced orders. Aggregates are
// incrementally maintained per-order, so copied-in rows won't update them — the host
// recomputes instead (source of truth = orders).
let onOrdersChanged = null;

/** Start per SYNC_MODE. opts.onOrdersChanged({up,down}) fires after order rows sync. */
function startCloudSync(opts = {}) {
  onOrdersChanged = typeof opts.onOrdersChanged === 'function' ? opts.onOrdersChanged : null;
  mode = resolveMode();
  if (mode === 'off') { console.log('☁️  cloud-sync: OFF (complete offline island).'); return 'off'; }
  if (!initPools()) {
    console.log('☁️  cloud-sync not started (needs CLOUD_DATABASE_URL ≠ local DATABASE_URL).');
    mode = 'off';
    return 'off';
  }
  ensureWatermarkTable()
    .then(() => ensureIdempotentUpdatedAt())
    .then(() => {
      const dirs = `↑${UP_TABLES.length}${DOWN_TABLES.length ? ` ↓${DOWN_TABLES.length}` : ''} tables`;
      if (mode === 'periodic') {
        console.log(`☁️  cloud-sync: PERIODIC every ${Math.round(INTERVAL_MS / 1000)}s (${dirs}).`);
        timer = setInterval(runCycle, INTERVAL_MS);
        runCycle();
      } else {
        console.log(`☁️  cloud-sync: MANUAL (${dirs}). Trigger via POST /api/local-server/sync-now.`);
      }
    })
    .catch((e) => console.warn('☁️  cloud-sync init failed:', e.message));
  return mode;
}

/** On-demand sync (used by the "Sync Now" endpoint). Works in periodic + manual modes. */
async function triggerSync() {
  if (mode === 'off' || !localPool) return { ok: false, mode, error: 'sync disabled (SYNC_MODE=off)' };
  const summary = await runCycle();
  return { ok: true, mode, ...summary };
}

async function getSyncStatus() {
  const status = {
    mode, upTables: UP_TABLES, downTables: DOWN_TABLES, intervalMs: INTERVAL_MS,
    running: cycleRunning, cyclesCompleted, lastCycleAt, watermarks: [],
    firstSyncDone: cyclesCompleted >= 1, totalSynced: 0, categories: [],
  };
  if (!localPool) return status;
  try {
    status.reachable = await cloudReachable();
    const r = await localPool.query('SELECT key, last_updated_at, last_run, last_error, rows_synced FROM sync_watermark ORDER BY key');
    status.watermarks = r.rows;
    // Friendly rollup for the loader: one row per table (direction stripped), total rows moved.
    const byTable = {};
    for (const w of r.rows) {
      const table = String(w.key).replace(/^(up|down):/, '');
      byTable[table] = (byTable[table] || 0) + Number(w.rows_synced || 0);
      status.totalSynced += Number(w.rows_synced || 0);
    }
    status.categories = Object.entries(byTable).map(([table, rows]) => ({ table, rows }));
  } catch (_) {}
  return status;
}

function stopCloudSync() {
  if (timer) clearInterval(timer);
  timer = null;
  if (localPool) localPool.end().catch(() => {});
  if (cloudPool) cloudPool.end().catch(() => {});
  localPool = cloudPool = null;
}

module.exports = { startCloudSync, stopCloudSync, runCycle, triggerSync, getSyncStatus };
