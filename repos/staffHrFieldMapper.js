/**
 * staffHrFieldMapper.js — camelCase (Firestore) <-> snake_case (PostgreSQL)
 * for staffUsers, attendance, leaveRequests, leaveConfig, leaveBalances,
 * payrollConfig, payrollRuns, paySlips collections.
 */

const { buildReverseMap, makeToPgRow, makeToFirestoreObj } = require('./queryBuilder');

// ── staffUsers ─────────────────────────────────────────────────────────────

const STAFF_FIELD_MAP = {
  id:               'id',
  restaurantId:     'restaurant_id',
  name:             'name',
  phone:            'phone',
  email:            'email',
  password:         'password',
  role:             'role',
  status:           'status',
  loginId:          'login_id',
  username:         'username',
  usernameLower:    'username_lower',
  address:          'address',
  aadhar:           'aadhar',
  salary:           'salary',
  startDate:        'start_date',
  phoneVerified:    'phone_verified',
  emailVerified:    'email_verified',
  provider:         'provider',
  temporaryPassword:'temporary_password',
  lastLogin:        'last_login',
  pageAccess:       'page_access',
  createdAt:        'created_at',
  updatedAt:        'updated_at',
};

const STAFF_REVERSE_MAP = buildReverseMap(STAFF_FIELD_MAP);
const STAFF_JSONB_COLUMNS = new Set(['page_access', 'extra_data']);

// ── attendance ─────────────────────────────────────────────────────────────

const ATTENDANCE_FIELD_MAP = {
  id:               'id',
  staffId:          'staff_id',
  staffName:        'staff_name',
  role:             'role',
  restaurantId:     'restaurant_id',
  date:             'date',
  status:           'status',
  clockIn:          'clock_in',
  clockOut:         'clock_out',
  clockInLocation:  'clock_in_location',
  clockOutLocation: 'clock_out_location',
  totalHours:       'total_hours',
  lateBy:           'late_by',
  overtimeHours:    'overtime_hours',
  earlyLeaveBy:     'early_leave_by',
  leaveType:        'leave_type',
  leaveRequestId:   'leave_request_id',
  isHalfDay:        'is_half_day',
  notes:            'notes',
  manualEntry:      'manual_entry',
  enteredBy:        'entered_by',
  createdAt:        'created_at',
  updatedAt:        'updated_at',
};

const ATTENDANCE_REVERSE_MAP = buildReverseMap(ATTENDANCE_FIELD_MAP);
const ATTENDANCE_JSONB_COLUMNS = new Set(['clock_in_location', 'clock_out_location', 'extra_data']);

// ── leaveRequests ──────────────────────────────────────────────────────────

const LEAVE_REQUEST_FIELD_MAP = {
  id:           'id',
  staffId:      'staff_id',
  staffName:    'staff_name',
  restaurantId: 'restaurant_id',
  leaveType:    'leave_type',
  startDate:    'start_date',
  endDate:      'end_date',
  isHalfDay:    'is_half_day',
  halfDayType:  'half_day_type',
  reason:       'reason',
  totalDays:    'total_days',
  status:       'status',
  approvedBy:   'approved_by',
  approvedAt:   'approved_at',
  rejectedReason:'rejected_reason',
  createdAt:    'created_at',
  updatedAt:    'updated_at',
};

const LEAVE_REQUEST_REVERSE_MAP = buildReverseMap(LEAVE_REQUEST_FIELD_MAP);
const LEAVE_REQUEST_JSONB_COLUMNS = new Set(['extra_data']);

// ── leaveConfig ────────────────────────────────────────────────────────────

const LEAVE_CONFIG_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  leaveTypes:          'leave_types',
  yearStart:           'year_start',
  weeklyOff:           'weekly_off',
  holidays:            'holidays',
  workStartTime:       'work_start_time',
  workEndTime:         'work_end_time',
  lateGracePeriod:     'late_grace_period',
  geoFenceEnabled:     'geo_fence_enabled',
  geoFenceRadius:      'geo_fence_radius',
  geoFenceLocation:    'geo_fence_location',
  overtimeEnabled:     'overtime_enabled',
  overtimeAfterHours:  'overtime_after_hours',
  autoClockOutEnabled: 'auto_clock_out_enabled',
  autoClockOutTime:    'auto_clock_out_time',
  trackingConfig:      'tracking_config',
  updatedAt:           'updated_at',
  updatedBy:           'updated_by',
};

const LEAVE_CONFIG_REVERSE_MAP = buildReverseMap(LEAVE_CONFIG_FIELD_MAP);
const LEAVE_CONFIG_JSONB_COLUMNS = new Set([
  'leave_types', 'weekly_off', 'holidays', 'geo_fence_location', 'tracking_config', 'extra_data',
]);

// ── leaveBalances ──────────────────────────────────────────────────────────

const LEAVE_BALANCE_FIELD_MAP = {
  id:           'id',
  staffId:      'staff_id',
  staffName:    'staff_name',
  restaurantId: 'restaurant_id',
  year:         'year',
  balances:     'balances',
  createdAt:    'created_at',
  updatedAt:    'updated_at',
};

const LEAVE_BALANCE_REVERSE_MAP = buildReverseMap(LEAVE_BALANCE_FIELD_MAP);
const LEAVE_BALANCE_JSONB_COLUMNS = new Set(['balances', 'extra_data']);

// ── payrollConfig ──────────────────────────────────────────────────────────

const PAYROLL_CONFIG_FIELD_MAP = {
  id:              'id',
  restaurantId:    'restaurant_id',
  staffId:         'staff_id',
  staffName:       'staff_name',
  role:            'role',
  baseSalary:      'base_salary',
  allowances:      'allowances',
  deductions:      'deductions',
  grossPay:        'gross_pay',
  totalDeductions: 'total_deductions',
  netPay:          'net_pay',
  payFrequency:    'pay_frequency',
  bankAccount:     'bank_account',
  createdBy:       'created_by',
  createdAt:       'created_at',
  updatedAt:       'updated_at',
};

const PAYROLL_CONFIG_REVERSE_MAP = buildReverseMap(PAYROLL_CONFIG_FIELD_MAP);
const PAYROLL_CONFIG_JSONB_COLUMNS = new Set(['allowances', 'deductions', 'extra_data']);

// ── payrollRuns ────────────────────────────────────────────────────────────

const PAYROLL_RUN_FIELD_MAP = {
  id:               'id',
  restaurantId:     'restaurant_id',
  month:            'month',
  totalGross:       'total_gross',
  totalDeductions:  'total_deductions',
  totalNet:         'total_net',
  staffCount:       'staff_count',
  workingDays:      'working_days',
  hasAttendanceData:'has_attendance_data',
  status:           'status',
  paidDate:         'paid_date',
  paidBy:           'paid_by',
  createdBy:        'created_by',
  createdAt:        'created_at',
  updatedAt:        'updated_at',
};

const PAYROLL_RUN_REVERSE_MAP = buildReverseMap(PAYROLL_RUN_FIELD_MAP);
const PAYROLL_RUN_JSONB_COLUMNS = new Set(['extra_data']);

// ── paySlips ───────────────────────────────────────────────────────────────

const PAY_SLIP_FIELD_MAP = {
  id:                'id',
  restaurantId:      'restaurant_id',
  runId:             'run_id',
  staffId:           'staff_id',
  staffName:         'staff_name',
  role:              'role',
  month:             'month',
  baseSalary:        'base_salary',
  allowances:        'allowances',
  deductions:        'deductions',
  grossPay:          'gross_pay',
  netPay:            'net_pay',
  attendanceSummary: 'attendance_summary',
  lopDeduction:      'lop_deduction',
  overtimePay:       'overtime_pay',
  status:            'status',
  paidDate:          'paid_date',
  createdAt:         'created_at',
};

const PAY_SLIP_REVERSE_MAP = buildReverseMap(PAY_SLIP_FIELD_MAP);
const PAY_SLIP_JSONB_COLUMNS = new Set(['allowances', 'deductions', 'attendance_summary', 'extra_data']);

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  staffToPgRow:        makeToPgRow(STAFF_FIELD_MAP, STAFF_JSONB_COLUMNS),
  staffToFirestoreObj: makeToFirestoreObj(STAFF_REVERSE_MAP),
  STAFF_FIELD_MAP, STAFF_REVERSE_MAP, STAFF_JSONB_COLUMNS,

  attendanceToPgRow:        makeToPgRow(ATTENDANCE_FIELD_MAP, ATTENDANCE_JSONB_COLUMNS),
  attendanceToFirestoreObj: makeToFirestoreObj(ATTENDANCE_REVERSE_MAP),
  ATTENDANCE_FIELD_MAP, ATTENDANCE_REVERSE_MAP, ATTENDANCE_JSONB_COLUMNS,

  leaveRequestToPgRow:        makeToPgRow(LEAVE_REQUEST_FIELD_MAP, LEAVE_REQUEST_JSONB_COLUMNS),
  leaveRequestToFirestoreObj: makeToFirestoreObj(LEAVE_REQUEST_REVERSE_MAP),
  LEAVE_REQUEST_FIELD_MAP, LEAVE_REQUEST_REVERSE_MAP, LEAVE_REQUEST_JSONB_COLUMNS,

  leaveConfigToPgRow:        makeToPgRow(LEAVE_CONFIG_FIELD_MAP, LEAVE_CONFIG_JSONB_COLUMNS),
  leaveConfigToFirestoreObj: makeToFirestoreObj(LEAVE_CONFIG_REVERSE_MAP),
  LEAVE_CONFIG_FIELD_MAP, LEAVE_CONFIG_REVERSE_MAP, LEAVE_CONFIG_JSONB_COLUMNS,

  leaveBalanceToPgRow:        makeToPgRow(LEAVE_BALANCE_FIELD_MAP, LEAVE_BALANCE_JSONB_COLUMNS),
  leaveBalanceToFirestoreObj: makeToFirestoreObj(LEAVE_BALANCE_REVERSE_MAP),
  LEAVE_BALANCE_FIELD_MAP, LEAVE_BALANCE_REVERSE_MAP, LEAVE_BALANCE_JSONB_COLUMNS,

  payrollConfigToPgRow:        makeToPgRow(PAYROLL_CONFIG_FIELD_MAP, PAYROLL_CONFIG_JSONB_COLUMNS),
  payrollConfigToFirestoreObj: makeToFirestoreObj(PAYROLL_CONFIG_REVERSE_MAP),
  PAYROLL_CONFIG_FIELD_MAP, PAYROLL_CONFIG_REVERSE_MAP, PAYROLL_CONFIG_JSONB_COLUMNS,

  payrollRunToPgRow:        makeToPgRow(PAYROLL_RUN_FIELD_MAP, PAYROLL_RUN_JSONB_COLUMNS),
  payrollRunToFirestoreObj: makeToFirestoreObj(PAYROLL_RUN_REVERSE_MAP),
  PAYROLL_RUN_FIELD_MAP, PAYROLL_RUN_REVERSE_MAP, PAYROLL_RUN_JSONB_COLUMNS,

  paySlipToPgRow:        makeToPgRow(PAY_SLIP_FIELD_MAP, PAY_SLIP_JSONB_COLUMNS),
  paySlipToFirestoreObj: makeToFirestoreObj(PAY_SLIP_REVERSE_MAP),
  PAY_SLIP_FIELD_MAP, PAY_SLIP_REVERSE_MAP, PAY_SLIP_JSONB_COLUMNS,
};
