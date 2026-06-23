/**
 * invoiceFieldMapper.js — Field maps for 10 invoice collections.
 *
 * Collections: inv_organizations, inv_customers, inv_items, inv_invoices,
 * inv_quotes, inv_challans, inv_payments, inv_expenses, inv_settings,
 * inv_number_sequences
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

// ── inv_organizations ────────────────────────────────────────────────────────

const ORG_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  logo: 'logo',
  gstin: 'gstin',
  pan: 'pan',
  currency: 'currency',
  dateFormat: 'date_format',
  fiscalYearStart: 'fiscal_year_start',
  theme: 'theme',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const ORG_JSONB_COLUMNS = new Set(['address', 'theme', 'extra_data']);
const orgToPgRow = makeToPgRow(ORG_FIELD_MAP, ORG_JSONB_COLUMNS);
const orgToFirestoreObj = makeToFirestoreObj(buildReverseMap(ORG_FIELD_MAP));

// ── inv_customers ────────────────────────────────────────────────────────────

const CUSTOMER_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  type: 'type',
  salutation: 'salutation',
  firstName: 'first_name',
  lastName: 'last_name',
  companyName: 'company_name',
  displayName: 'display_name',
  email: 'email',
  workPhone: 'work_phone',
  mobile: 'mobile',
  pan: 'pan',
  gstin: 'gstin',
  currency: 'currency',
  paymentTerms: 'payment_terms',
  language: 'language',
  billingAddress: 'billing_address',
  shippingAddress: 'shipping_address',
  contactPersons: 'contact_persons',
  notes: 'notes',
  customFields: 'custom_fields',
  status: 'status',
  sourceApp: 'source_app',
  sourceRef: 'source_ref',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const CUSTOMER_JSONB_COLUMNS = new Set(['billing_address', 'shipping_address', 'contact_persons', 'custom_fields', 'extra_data']);
const customerToPgRow = makeToPgRow(CUSTOMER_FIELD_MAP, CUSTOMER_JSONB_COLUMNS);
const customerToFirestoreObj = makeToFirestoreObj(buildReverseMap(CUSTOMER_FIELD_MAP));

// ── inv_items ────────────────────────────────────────────────────────────────

const ITEM_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  name: 'name',
  type: 'type',
  unit: 'unit',
  sellingPrice: 'selling_price',
  costPrice: 'cost_price',
  description: 'description',
  taxRate: 'tax_rate',
  taxType: 'tax_type',
  hsnCode: 'hsn_code',
  sku: 'sku',
  image: 'image',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const ITEM_JSONB_COLUMNS = new Set(['extra_data']);
const itemToPgRow = makeToPgRow(ITEM_FIELD_MAP, ITEM_JSONB_COLUMNS);
const itemToFirestoreObj = makeToFirestoreObj(buildReverseMap(ITEM_FIELD_MAP));

// ── inv_invoices ─────────────────────────────────────────────────────────────

const INVOICE_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  customerId: 'customer_id',
  customerName: 'customer_name',
  invoiceNumber: 'invoice_number',
  referenceNumber: 'reference_number',
  invoiceDate: 'invoice_date',
  dueDate: 'due_date',
  paymentTerms: 'payment_terms',
  salesperson: 'salesperson',
  items: 'items',
  subtotal: 'subtotal',
  discountType: 'discount_type',
  discountValue: 'discount_value',
  discountAmount: 'discount_amount',
  taxAmount: 'tax_amount',
  taxBreakdown: 'tax_breakdown',
  adjustments: 'adjustments',
  total: 'total',
  paidAmount: 'paid_amount',
  balanceDue: 'balance_due',
  customerNotes: 'customer_notes',
  termsAndConditions: 'terms_and_conditions',
  attachments: 'attachments',
  status: 'status',
  sourceApp: 'source_app',
  sourceRef: 'source_ref',
  sentAt: 'sent_at',
  paidAt: 'paid_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const INVOICE_JSONB_COLUMNS = new Set(['items', 'tax_breakdown', 'attachments', 'extra_data']);
const invoiceToPgRow = makeToPgRow(INVOICE_FIELD_MAP, INVOICE_JSONB_COLUMNS);
const invoiceToFirestoreObj = makeToFirestoreObj(buildReverseMap(INVOICE_FIELD_MAP));

// ── inv_quotes ───────────────────────────────────────────────────────────────

const QUOTE_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  customerId: 'customer_id',
  customerName: 'customer_name',
  quoteNumber: 'quote_number',
  referenceNumber: 'reference_number',
  quoteDate: 'quote_date',
  expiryDate: 'expiry_date',
  salesperson: 'salesperson',
  projectName: 'project_name',
  subject: 'subject',
  items: 'items',
  subtotal: 'subtotal',
  discountType: 'discount_type',
  discountValue: 'discount_value',
  discountAmount: 'discount_amount',
  taxAmount: 'tax_amount',
  total: 'total',
  customerNotes: 'customer_notes',
  termsAndConditions: 'terms_and_conditions',
  status: 'status',
  convertedInvoiceId: 'converted_invoice_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const QUOTE_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const quoteToPgRow = makeToPgRow(QUOTE_FIELD_MAP, QUOTE_JSONB_COLUMNS);
const quoteToFirestoreObj = makeToFirestoreObj(buildReverseMap(QUOTE_FIELD_MAP));

// ── inv_challans ─────────────────────────────────────────────────────────────

const CHALLAN_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  customerId: 'customer_id',
  customerName: 'customer_name',
  challanNumber: 'challan_number',
  referenceNumber: 'reference_number',
  challanDate: 'challan_date',
  challanType: 'challan_type',
  items: 'items',
  subtotal: 'subtotal',
  discountAmount: 'discount_amount',
  adjustments: 'adjustments',
  total: 'total',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const CHALLAN_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const challanToPgRow = makeToPgRow(CHALLAN_FIELD_MAP, CHALLAN_JSONB_COLUMNS);
const challanToFirestoreObj = makeToFirestoreObj(buildReverseMap(CHALLAN_FIELD_MAP));

// ── inv_payments ─────────────────────────────────────────────────────────────

const PAYMENT_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  customerId: 'customer_id',
  invoiceId: 'invoice_id',
  paymentNumber: 'payment_number',
  paymentDate: 'payment_date',
  amount: 'amount',
  paymentMode: 'payment_mode',
  referenceNumber: 'reference_number',
  notes: 'notes',
  createdAt: 'created_at',
};

const PAYMENT_JSONB_COLUMNS = new Set(['extra_data']);
const paymentToPgRow = makeToPgRow(PAYMENT_FIELD_MAP, PAYMENT_JSONB_COLUMNS);
const paymentToFirestoreObj = makeToFirestoreObj(buildReverseMap(PAYMENT_FIELD_MAP));

// ── inv_expenses ─────────────────────────────────────────────────────────────

const EXPENSE_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  date: 'date',
  category: 'category',
  amount: 'amount',
  currency: 'currency',
  invoiceNumber: 'invoice_number',
  notes: 'notes',
  customerId: 'customer_id',
  receipt: 'receipt',
  isBillable: 'is_billable',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const EXPENSE_JSONB_COLUMNS = new Set(['extra_data']);
const expenseToPgRow = makeToPgRow(EXPENSE_FIELD_MAP, EXPENSE_JSONB_COLUMNS);
const expenseToFirestoreObj = makeToFirestoreObj(buildReverseMap(EXPENSE_FIELD_MAP));

// ── inv_settings ─────────────────────────────────────────────────────────────

const SETTINGS_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  invoiceNumberPrefix: 'invoice_number_prefix',
  invoiceStartNumber: 'invoice_start_number',
  quoteNumberPrefix: 'quote_number_prefix',
  challanNumberPrefix: 'challan_number_prefix',
  paymentNumberPrefix: 'payment_number_prefix',
  defaultPaymentTerms: 'default_payment_terms',
  defaultCustomerNotes: 'default_customer_notes',
  defaultTermsAndConditions: 'default_terms_and_conditions',
  taxSettings: 'tax_settings',
  pdfTemplate: 'pdf_template',
  pdfColors: 'pdf_colors',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SETTINGS_JSONB_COLUMNS = new Set(['tax_settings', 'pdf_colors', 'extra_data']);
const settingsToPgRow = makeToPgRow(SETTINGS_FIELD_MAP, SETTINGS_JSONB_COLUMNS);
const settingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(SETTINGS_FIELD_MAP));

// ── inv_number_sequences ─────────────────────────────────────────────────────

const NUMBER_SEQ_FIELD_MAP = {
  id: 'id',
  orgId: 'org_id',
  type: 'type',
  prefix: 'prefix',
  currentNumber: 'current_number',
  updatedAt: 'updated_at',
};

const NUMBER_SEQ_JSONB_COLUMNS = new Set(['extra_data']);
const numberSeqToPgRow = makeToPgRow(NUMBER_SEQ_FIELD_MAP, NUMBER_SEQ_JSONB_COLUMNS);
const numberSeqToFirestoreObj = makeToFirestoreObj(buildReverseMap(NUMBER_SEQ_FIELD_MAP));

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Organizations
  orgToPgRow, orgToFirestoreObj, ORG_JSONB_COLUMNS,
  // Customers
  customerToPgRow, customerToFirestoreObj, CUSTOMER_JSONB_COLUMNS,
  // Items
  itemToPgRow, itemToFirestoreObj, ITEM_JSONB_COLUMNS,
  // Invoices
  invoiceToPgRow, invoiceToFirestoreObj, INVOICE_JSONB_COLUMNS,
  // Quotes
  quoteToPgRow, quoteToFirestoreObj, QUOTE_JSONB_COLUMNS,
  // Challans
  challanToPgRow, challanToFirestoreObj, CHALLAN_JSONB_COLUMNS,
  // Payments
  paymentToPgRow, paymentToFirestoreObj, PAYMENT_JSONB_COLUMNS,
  // Expenses
  expenseToPgRow, expenseToFirestoreObj, EXPENSE_JSONB_COLUMNS,
  // Settings
  settingsToPgRow, settingsToFirestoreObj, SETTINGS_JSONB_COLUMNS,
  // Number sequences
  numberSeqToPgRow, numberSeqToFirestoreObj, NUMBER_SEQ_JSONB_COLUMNS,
};
