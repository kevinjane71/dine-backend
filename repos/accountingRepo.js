/**
 * accountingRepo.js — PostgreSQL data access for chartOfAccounts,
 * journalEntries, and expenses.
 */

const { query } = require('./pgClient');
const {
  coaToPgRow, coaToFirestoreObj, COA_JSONB_COLUMNS,
  jeToPgRow, jeToFirestoreObj, JE_JSONB_COLUMNS,
  expToPgRow, expToFirestoreObj, EXP_JSONB_COLUMNS,
} = require('./accountingFieldMapper');

function jsonbVal(col, val, jsonbCols) {
  return jsonbCols.has(col) && val !== null && val !== undefined
    ? JSON.stringify(val) : val;
}

function buildUpsert(tableName, pgRow, jsonbCols) {
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) =>
    jsonbCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  ).join(', ');
  const values = cols.map(c => jsonbVal(c, pgRow[c], jsonbCols));
  const updateCols = cols.filter(c => c !== 'id');
  return {
    text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}
           RETURNING *`,
    values,
  };
}

// ── Chart of Accounts ─────────────────────────────────────────────────────

async function createAccount(accountId, data) {
  const pgRow = coaToPgRow({ id: accountId, ...data });
  if (!pgRow.id) pgRow.id = accountId;
  const q = buildUpsert('chart_of_accounts', pgRow, COA_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? coaToFirestoreObj(result.rows[0]) : null;
}

async function bulkCreateAccounts(accounts) {
  for (const acct of accounts) {
    const pgRow = coaToPgRow(acct);
    if (!pgRow.id) continue;
    const q = buildUpsert('chart_of_accounts', pgRow, COA_JSONB_COLUMNS);
    await query(q.text, q.values);
  }
}

async function getAccountsByRestaurant(restaurantId) {
  const result = await query(
    'SELECT * FROM chart_of_accounts WHERE restaurant_id = $1 ORDER BY code ASC',
    [restaurantId]
  );
  return result.rows.map(coaToFirestoreObj);
}

// ── Journal Entries ───────────────────────────────────────────────────────

async function createJournalEntry(entryId, data) {
  const pgRow = jeToPgRow({ id: entryId, ...data });
  if (!pgRow.id) pgRow.id = entryId;
  const q = buildUpsert('journal_entries', pgRow, JE_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? jeToFirestoreObj(result.rows[0]) : null;
}

async function getJournalEntries(restaurantId, { startDate, endDate, limit = 100 } = {}) {
  let sql = 'SELECT * FROM journal_entries WHERE restaurant_id = $1';
  const params = [restaurantId];
  let i = 2;
  if (startDate) { sql += ` AND date >= $${i++}`; params.push(startDate); }
  if (endDate) { sql += ` AND date <= $${i++}`; params.push(endDate); }
  sql += ` ORDER BY date DESC LIMIT $${i}`;
  params.push(limit);
  const result = await query(sql, params);
  return result.rows.map(jeToFirestoreObj);
}

// ── Expenses ──────────────────────────────────────────────────────────────

async function createExpense(expenseId, data) {
  const pgRow = expToPgRow({ id: expenseId, ...data });
  if (!pgRow.id) pgRow.id = expenseId;
  const q = buildUpsert('expenses', pgRow, EXP_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? expToFirestoreObj(result.rows[0]) : null;
}

async function updateExpense(expenseId, updates) {
  const pgRow = expToPgRow(updates);
  delete pgRow.id;
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const col of cols) {
    if (EXP_JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(jsonbVal(col, pgRow[col], EXP_JSONB_COLUMNS));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }
  values.push(expenseId);
  await query(`UPDATE expenses SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
}

async function deleteExpense(expenseId) {
  await query('DELETE FROM expenses WHERE id = $1', [expenseId]);
}

async function getExpensesByRestaurant(restaurantId, { startDate, endDate, category } = {}) {
  let sql = 'SELECT * FROM expenses WHERE restaurant_id = $1';
  const params = [restaurantId];
  let i = 2;
  if (startDate) { sql += ` AND date >= $${i++}`; params.push(startDate); }
  if (endDate) { sql += ` AND date <= $${i++}`; params.push(endDate); }
  if (category) { sql += ` AND category = $${i++}`; params.push(category); }
  sql += ' ORDER BY date DESC';
  const result = await query(sql, params);
  return result.rows.map(expToFirestoreObj);
}

module.exports = {
  createAccount, bulkCreateAccounts, getAccountsByRestaurant,
  createJournalEntry, getJournalEntries,
  createExpense, updateExpense, deleteExpense, getExpensesByRestaurant,
};
