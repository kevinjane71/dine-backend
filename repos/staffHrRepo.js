/**
 * staffHrRepo.js — PostgreSQL data access for staffUsers, attendance,
 * leaveRequests, leaveConfig, leaveBalances, payrollConfig, payrollRuns, paySlips.
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
  staffToPgRow, staffToFirestoreObj, STAFF_JSONB_COLUMNS,
  attendanceToPgRow, attendanceToFirestoreObj, ATTENDANCE_JSONB_COLUMNS,
  leaveRequestToPgRow, leaveRequestToFirestoreObj, LEAVE_REQUEST_JSONB_COLUMNS,
  leaveConfigToPgRow, leaveConfigToFirestoreObj, LEAVE_CONFIG_JSONB_COLUMNS,
  leaveBalanceToPgRow, leaveBalanceToFirestoreObj, LEAVE_BALANCE_JSONB_COLUMNS,
  payrollConfigToPgRow, payrollConfigToFirestoreObj, PAYROLL_CONFIG_JSONB_COLUMNS,
  payrollRunToPgRow, payrollRunToFirestoreObj, PAYROLL_RUN_JSONB_COLUMNS,
  paySlipToPgRow, paySlipToFirestoreObj, PAY_SLIP_JSONB_COLUMNS,
} = require('./staffHrFieldMapper');

// ── Staff Users ──────────────────────────────────────────────────────────

async function createStaff(staffId, data) {
  const pgRow = staffToPgRow({ id: staffId, ...data });
  if (!pgRow.id) pgRow.id = staffId;
  const q = buildUpsert('staff_users', pgRow, STAFF_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? staffToFirestoreObj(result.rows[0]) : null;
}

async function updateStaff(staffId, updates) {
  const pgRow = staffToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('staff_users', staffId, pgRow, STAFF_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function deleteStaff(staffId) {
  await query('DELETE FROM staff_users WHERE id = $1', [staffId]);
}

async function getStaffByRestaurant(restaurantId) {
  const result = await query(
    'SELECT * FROM staff_users WHERE restaurant_id = $1 ORDER BY name ASC',
    [restaurantId]
  );
  return result.rows.map(staffToFirestoreObj);
}

// ── Attendance ───────────────────────────────────────────────────────────

async function upsertAttendance(docId, data) {
  const pgRow = attendanceToPgRow({ id: docId, ...data });
  if (!pgRow.id) pgRow.id = docId;
  const q = buildUpsert('attendance', pgRow, ATTENDANCE_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? attendanceToFirestoreObj(result.rows[0]) : null;
}

async function updateAttendance(docId, updates) {
  const pgRow = attendanceToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('attendance', docId, pgRow, ATTENDANCE_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function bulkUpsertAttendance(records) {
  for (const rec of records) {
    const pgRow = attendanceToPgRow(rec);
    if (!pgRow.id) continue;
    const q = buildUpsert('attendance', pgRow, ATTENDANCE_JSONB_COLUMNS);
    await query(q.text, q.values);
  }
}

// ── Leave Requests ───────────────────────────────────────────────────────

async function createLeaveRequest(requestId, data) {
  const pgRow = leaveRequestToPgRow({ id: requestId, ...data });
  if (!pgRow.id) pgRow.id = requestId;
  const q = buildUpsert('leave_requests', pgRow, LEAVE_REQUEST_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? leaveRequestToFirestoreObj(result.rows[0]) : null;
}

async function updateLeaveRequest(requestId, updates) {
  const pgRow = leaveRequestToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('leave_requests', requestId, pgRow, LEAVE_REQUEST_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

// ── Leave Config ─────────────────────────────────────────────────────────

async function upsertLeaveConfig(restaurantId, data) {
  const pgRow = leaveConfigToPgRow({ id: restaurantId, restaurantId, ...data });
  if (!pgRow.id) pgRow.id = restaurantId;
  const q = buildUpsert('leave_config', pgRow, LEAVE_CONFIG_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? leaveConfigToFirestoreObj(result.rows[0]) : null;
}

// ── Leave Balances ───────────────────────────────────────────────────────

async function upsertLeaveBalance(docId, data) {
  const pgRow = leaveBalanceToPgRow({ id: docId, ...data });
  if (!pgRow.id) pgRow.id = docId;
  const q = buildUpsert('leave_balances', pgRow, LEAVE_BALANCE_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? leaveBalanceToFirestoreObj(result.rows[0]) : null;
}

async function updateLeaveBalance(docId, updates) {
  const pgRow = leaveBalanceToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('leave_balances', docId, pgRow, LEAVE_BALANCE_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function bulkUpsertLeaveBalances(records) {
  for (const rec of records) {
    const pgRow = leaveBalanceToPgRow(rec);
    if (!pgRow.id) continue;
    const q = buildUpsert('leave_balances', pgRow, LEAVE_BALANCE_JSONB_COLUMNS);
    await query(q.text, q.values);
  }
}

// ── Payroll Config ───────────────────────────────────────────────────────

async function createPayrollConfig(configId, data) {
  const pgRow = payrollConfigToPgRow({ id: configId, ...data });
  if (!pgRow.id) pgRow.id = configId;
  const q = buildUpsert('payroll_config', pgRow, PAYROLL_CONFIG_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? payrollConfigToFirestoreObj(result.rows[0]) : null;
}

async function updatePayrollConfig(configId, updates) {
  const pgRow = payrollConfigToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('payroll_config', configId, pgRow, PAYROLL_CONFIG_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function deletePayrollConfig(configId) {
  await query('DELETE FROM payroll_config WHERE id = $1', [configId]);
}

// ── Payroll Runs ─────────────────────────────────────────────────────────

async function createPayrollRun(runId, data) {
  const pgRow = payrollRunToPgRow({ id: runId, ...data });
  if (!pgRow.id) pgRow.id = runId;
  const q = buildUpsert('payroll_runs', pgRow, PAYROLL_RUN_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? payrollRunToFirestoreObj(result.rows[0]) : null;
}

async function updatePayrollRun(runId, updates) {
  const pgRow = payrollRunToPgRow(updates);
  delete pgRow.id;
  const q = buildUpdate('payroll_runs', runId, pgRow, PAYROLL_RUN_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

// ── Pay Slips ────────────────────────────────────────────────────────────

async function createPaySlip(slipId, data) {
  const pgRow = paySlipToPgRow({ id: slipId, ...data });
  if (!pgRow.id) pgRow.id = slipId;
  const q = buildUpsert('pay_slips', pgRow, PAY_SLIP_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? paySlipToFirestoreObj(result.rows[0]) : null;
}

async function bulkCreatePaySlips(slips) {
  for (const slip of slips) {
    const pgRow = paySlipToPgRow(slip);
    if (!pgRow.id) continue;
    const q = buildUpsert('pay_slips', pgRow, PAY_SLIP_JSONB_COLUMNS);
    await query(q.text, q.values);
  }
}

async function updatePaySlipsByRunId(runId, updates) {
  const pgRow = paySlipToPgRow(updates);
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const col of cols) {
    if (PAY_SLIP_JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(typeof pgRow[col] === 'object' && pgRow[col] !== null ? JSON.stringify(pgRow[col]) : pgRow[col]);
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }
  values.push(runId);
  await query(`UPDATE pay_slips SET ${setClauses.join(', ')} WHERE run_id = $${i}`, values);
}

module.exports = {
  // Staff
  createStaff, updateStaff, deleteStaff, getStaffByRestaurant,
  // Attendance
  upsertAttendance, updateAttendance, bulkUpsertAttendance,
  // Leave
  createLeaveRequest, updateLeaveRequest,
  upsertLeaveConfig,
  upsertLeaveBalance, updateLeaveBalance, bulkUpsertLeaveBalances,
  // Payroll
  createPayrollConfig, updatePayrollConfig, deletePayrollConfig,
  createPayrollRun, updatePayrollRun,
  createPaySlip, bulkCreatePaySlips, updatePaySlipsByRunId,
};
