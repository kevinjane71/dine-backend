/**
 * printDiagnosticsFieldMapper.js — Field map for the `printDiagnostics` collection.
 *
 * Backs the /api/print-diagnostics telemetry endpoint. On the PostgreSQL branch
 * this maps the Firestore-style document to the `print_diagnostics` table. On
 * the Firestore branch this file is never loaded (collectionRegistry is only
 * required when DATABASE_URL is set), so it's inert there.
 *
 * DDL: scripts/create-print-diagnostics-table.sql
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

const PRINT_DIAG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  terminalId: 'terminal_id',
  type: 'type',
  method: 'method',
  success: 'success',
  deviceName: 'device_name',
  deviceMatched: 'device_matched',
  failureReason: 'failure_reason',
  hint: 'hint',
  os: 'os',
  appVersion: 'app_version',
  electronVersion: 'electron_version',
  event: 'event',
  createdAt: 'created_at',
};

// `event` holds the full sanitized diagnostic blob; extra_data catches anything
// the pgAdapter can't map to a real column.
const PRINT_DIAG_JSONB_COLUMNS = new Set(['event', 'extra_data']);

const printDiagToPgRow = makeToPgRow(PRINT_DIAG_FIELD_MAP, PRINT_DIAG_JSONB_COLUMNS);
const printDiagToFirestoreObj = makeToFirestoreObj(buildReverseMap(PRINT_DIAG_FIELD_MAP));

module.exports = {
  PRINT_DIAG_FIELD_MAP,
  PRINT_DIAG_JSONB_COLUMNS,
  printDiagToPgRow,
  printDiagToFirestoreObj,
};
