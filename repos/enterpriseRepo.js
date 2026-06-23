/**
 * enterpriseRepo.js — PostgreSQL data access for 8 enterprise/organization collections.
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
  orgToPgRow, orgToFirestoreObj, ORG_JSONB_COLUMNS,
  menuTemplateToPgRow, menuTemplateToFirestoreObj, MENU_TEMPLATE_JSONB_COLUMNS,
  menuItemToPgRow, menuItemToFirestoreObj, MENU_ITEM_JSONB_COLUMNS,
  indentToPgRow, indentToFirestoreObj, INDENT_JSONB_COLUMNS,
  productionOrderToPgRow, productionOrderToFirestoreObj, PRODUCTION_ORDER_JSONB_COLUMNS,
  distributionPlanToPgRow, distributionPlanToFirestoreObj, DISTRIBUTION_PLAN_JSONB_COLUMNS,
  orgSettingsToPgRow, orgSettingsToFirestoreObj, ORG_SETTINGS_JSONB_COLUMNS,
  auditLogToPgRow, auditLogToFirestoreObj, AUDIT_LOG_JSONB_COLUMNS,
} = require('./enterpriseFieldMapper');

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
const upsertOrg = makeUpsert('ent_organizations', orgToPgRow, ORG_JSONB_COLUMNS, orgToFirestoreObj);
const updateOrg = makeUpdate('ent_organizations', orgToPgRow, ORG_JSONB_COLUMNS);

// ── Menu Templates ───────────────────────────────────────────────────────────
const upsertMenuTemplate = makeUpsert('org_menu_templates', menuTemplateToPgRow, MENU_TEMPLATE_JSONB_COLUMNS, menuTemplateToFirestoreObj);
const updateMenuTemplate = makeUpdate('org_menu_templates', menuTemplateToPgRow, MENU_TEMPLATE_JSONB_COLUMNS);

// ── Menu Items ───────────────────────────────────────────────────────────────
const upsertMenuItem = makeUpsert('org_menu_items', menuItemToPgRow, MENU_ITEM_JSONB_COLUMNS, menuItemToFirestoreObj);
const updateMenuItem = makeUpdate('org_menu_items', menuItemToPgRow, MENU_ITEM_JSONB_COLUMNS);

// ── Indent Requests ──────────────────────────────────────────────────────────
const upsertIndent = makeUpsert('indent_requests', indentToPgRow, INDENT_JSONB_COLUMNS, indentToFirestoreObj);
const updateIndent = makeUpdate('indent_requests', indentToPgRow, INDENT_JSONB_COLUMNS);

// ── Production Orders ────────────────────────────────────────────────────────
const upsertProductionOrder = makeUpsert('production_orders', productionOrderToPgRow, PRODUCTION_ORDER_JSONB_COLUMNS, productionOrderToFirestoreObj);
const updateProductionOrder = makeUpdate('production_orders', productionOrderToPgRow, PRODUCTION_ORDER_JSONB_COLUMNS);

// ── Distribution Plans ───────────────────────────────────────────────────────
const upsertDistributionPlan = makeUpsert('distribution_plans', distributionPlanToPgRow, DISTRIBUTION_PLAN_JSONB_COLUMNS, distributionPlanToFirestoreObj);
const updateDistributionPlan = makeUpdate('distribution_plans', distributionPlanToPgRow, DISTRIBUTION_PLAN_JSONB_COLUMNS);

// ── Org Settings (counters) ──────────────────────────────────────────────────
const upsertOrgSettings = makeUpsert('org_settings', orgSettingsToPgRow, ORG_SETTINGS_JSONB_COLUMNS, orgSettingsToFirestoreObj);
const updateOrgSettings = makeUpdate('org_settings', orgSettingsToPgRow, ORG_SETTINGS_JSONB_COLUMNS);

// ── Audit Log (append-only) ──────────────────────────────────────────────────
const upsertAuditLog = makeUpsert('org_audit_log', auditLogToPgRow, AUDIT_LOG_JSONB_COLUMNS, auditLogToFirestoreObj);

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  upsertOrg, updateOrg,
  upsertMenuTemplate, updateMenuTemplate,
  upsertMenuItem, updateMenuItem,
  upsertIndent, updateIndent,
  upsertProductionOrder, updateProductionOrder,
  upsertDistributionPlan, updateDistributionPlan,
  upsertOrgSettings, updateOrgSettings,
  upsertAuditLog,
};
