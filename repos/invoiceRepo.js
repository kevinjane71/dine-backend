/**
 * invoiceRepo.js — PostgreSQL data access for 10 invoice module collections.
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
  orgToPgRow, orgToFirestoreObj, ORG_JSONB_COLUMNS,
  customerToPgRow, customerToFirestoreObj, CUSTOMER_JSONB_COLUMNS,
  itemToPgRow, itemToFirestoreObj, ITEM_JSONB_COLUMNS,
  invoiceToPgRow, invoiceToFirestoreObj, INVOICE_JSONB_COLUMNS,
  quoteToPgRow, quoteToFirestoreObj, QUOTE_JSONB_COLUMNS,
  challanToPgRow, challanToFirestoreObj, CHALLAN_JSONB_COLUMNS,
  paymentToPgRow, paymentToFirestoreObj, PAYMENT_JSONB_COLUMNS,
  expenseToPgRow, expenseToFirestoreObj, EXPENSE_JSONB_COLUMNS,
  settingsToPgRow, settingsToFirestoreObj, SETTINGS_JSONB_COLUMNS,
  numberSeqToPgRow, numberSeqToFirestoreObj, NUMBER_SEQ_JSONB_COLUMNS,
} = require('./invoiceFieldMapper');

// ── Generic helpers ──────────────────────────────────────────────────────────

function makeUpsert(table, toPgRowFn, jsonbCols, toFsObjFn) {
  return async function upsert(docId, data) {
    const pgRow = toPgRowFn({ id: docId, ...data });
    if (!pgRow.id) pgRow.id = docId;
    const q = buildUpsert(table, pgRow, jsonbCols);
    const result = await query(q.text, q.values);
    return result.rows.length > 0 ? toFsObjFn(result.rows[0]) : null;
  };
}

function makeUpdate(table, toPgRowFn, jsonbCols) {
  return async function update(docId, updates) {
    const pgRow = toPgRowFn(updates);
    delete pgRow.id;
    const q = buildUpdate(table, docId, pgRow, jsonbCols);
    if (!q) return;
    await query(q.text, q.values);
  };
}

function makeDelete(table) {
  return async function remove(docId) {
    await query(`DELETE FROM ${table} WHERE id = $1`, [docId]);
  };
}

// ── Organizations ────────────────────────────────────────────────────────────
const upsertOrg = makeUpsert('inv_organizations', orgToPgRow, ORG_JSONB_COLUMNS, orgToFirestoreObj);
const updateOrg = makeUpdate('inv_organizations', orgToPgRow, ORG_JSONB_COLUMNS);

// ── Customers ────────────────────────────────────────────────────────────────
const upsertCustomer = makeUpsert('inv_customers', customerToPgRow, CUSTOMER_JSONB_COLUMNS, customerToFirestoreObj);
const updateCustomer = makeUpdate('inv_customers', customerToPgRow, CUSTOMER_JSONB_COLUMNS);
const deleteCustomer = makeDelete('inv_customers');

// ── Items ────────────────────────────────────────────────────────────────────
const upsertItem = makeUpsert('inv_items', itemToPgRow, ITEM_JSONB_COLUMNS, itemToFirestoreObj);
const updateItem = makeUpdate('inv_items', itemToPgRow, ITEM_JSONB_COLUMNS);
const deleteItem = makeDelete('inv_items');

// ── Invoices ─────────────────────────────────────────────────────────────────
const upsertInvoice = makeUpsert('inv_invoices', invoiceToPgRow, INVOICE_JSONB_COLUMNS, invoiceToFirestoreObj);
const updateInvoice = makeUpdate('inv_invoices', invoiceToPgRow, INVOICE_JSONB_COLUMNS);
const deleteInvoice = makeDelete('inv_invoices');

// ── Quotes ───────────────────────────────────────────────────────────────────
const upsertQuote = makeUpsert('inv_quotes', quoteToPgRow, QUOTE_JSONB_COLUMNS, quoteToFirestoreObj);
const updateQuote = makeUpdate('inv_quotes', quoteToPgRow, QUOTE_JSONB_COLUMNS);
const deleteQuote = makeDelete('inv_quotes');

// ── Challans ─────────────────────────────────────────────────────────────────
const upsertChallan = makeUpsert('inv_challans', challanToPgRow, CHALLAN_JSONB_COLUMNS, challanToFirestoreObj);
const updateChallan = makeUpdate('inv_challans', challanToPgRow, CHALLAN_JSONB_COLUMNS);
const deleteChallan = makeDelete('inv_challans');

// ── Payments ─────────────────────────────────────────────────────────────────
const upsertPayment = makeUpsert('inv_payments', paymentToPgRow, PAYMENT_JSONB_COLUMNS, paymentToFirestoreObj);
const deletePayment = makeDelete('inv_payments');

// ── Expenses ─────────────────────────────────────────────────────────────────
const upsertExpense = makeUpsert('inv_expenses', expenseToPgRow, EXPENSE_JSONB_COLUMNS, expenseToFirestoreObj);
const updateExpense = makeUpdate('inv_expenses', expenseToPgRow, EXPENSE_JSONB_COLUMNS);
const deleteExpense = makeDelete('inv_expenses');

// ── Settings ─────────────────────────────────────────────────────────────────
const upsertSettings = makeUpsert('inv_settings', settingsToPgRow, SETTINGS_JSONB_COLUMNS, settingsToFirestoreObj);
const updateSettings = makeUpdate('inv_settings', settingsToPgRow, SETTINGS_JSONB_COLUMNS);

// ── Number Sequences ─────────────────────────────────────────────────────────
const upsertNumberSeq = makeUpsert('inv_number_sequences', numberSeqToPgRow, NUMBER_SEQ_JSONB_COLUMNS, numberSeqToFirestoreObj);
const updateNumberSeq = makeUpdate('inv_number_sequences', numberSeqToPgRow, NUMBER_SEQ_JSONB_COLUMNS);

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  upsertOrg, updateOrg,
  upsertCustomer, updateCustomer, deleteCustomer,
  upsertItem, updateItem, deleteItem,
  upsertInvoice, updateInvoice, deleteInvoice,
  upsertQuote, updateQuote, deleteQuote,
  upsertChallan, updateChallan, deleteChallan,
  upsertPayment, deletePayment,
  upsertExpense, updateExpense, deleteExpense,
  upsertSettings, updateSettings,
  upsertNumberSeq, updateNumberSeq,
};
