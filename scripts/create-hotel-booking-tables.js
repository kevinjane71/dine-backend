#!/usr/bin/env node
/**
 * Create PG tables for hotel, PMS, and booking collections.
 */
require('dotenv').config({ path: '.env.local' });
const { query } = require('../repos/pgClient');

const DDL = `
-- ── Hotel Rooms ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotel_rooms (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  room_number TEXT,
  type TEXT DEFAULT 'standard',
  floor TEXT,
  capacity INTEGER DEFAULT 2,
  amenities JSONB DEFAULT '[]'::jsonb,
  tariff NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'available',
  current_guest TEXT,
  check_in_id TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hotel_rooms_restaurant ON hotel_rooms (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_hotel_rooms_restaurant_number ON hotel_rooms (restaurant_id, room_number);

-- ── Hotel Bookings ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotel_bookings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  room_id TEXT,
  room_number TEXT,
  guest_name TEXT,
  guest_phone TEXT,
  guest_email TEXT,
  check_in_date TEXT,
  check_out_date TEXT,
  number_of_guests INTEGER DEFAULT 1,
  stay_duration INTEGER DEFAULT 0,
  estimated_tariff NUMERIC DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  special_requests TEXT,
  booking_source TEXT DEFAULT 'front-desk',
  status TEXT DEFAULT 'confirmed',
  unavailable_override BOOLEAN DEFAULT FALSE,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  check_in_id TEXT,
  checked_out_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hotel_bookings_restaurant ON hotel_bookings (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_hotel_bookings_restaurant_status ON hotel_bookings (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_hotel_bookings_room ON hotel_bookings (restaurant_id, room_number);

-- ── Hotel Checkins ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotel_checkins (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  guest_id TEXT,
  room_id TEXT,
  room_number TEXT,
  guest_name TEXT,
  guest_phone TEXT,
  guest_email TEXT,
  check_in_date TIMESTAMPTZ,
  check_out_date TIMESTAMPTZ,
  stay_duration INTEGER DEFAULT 0,
  number_of_guests INTEGER DEFAULT 1,
  room_tariff NUMERIC DEFAULT 0,
  total_room_charges NUMERIC DEFAULT 0,
  advance_payment NUMERIC DEFAULT 0,
  payment_mode TEXT DEFAULT 'cash',
  special_requests TEXT,
  status TEXT DEFAULT 'checked-in',
  food_orders JSONB DEFAULT '[]'::jsonb,
  total_food_charges NUMERIC DEFAULT 0,
  total_charges NUMERIC DEFAULT 0,
  balance_amount NUMERIC DEFAULT 0,
  id_proof JSONB,
  gst_info JSONB,
  check_in_by TEXT,
  check_in_at TIMESTAMPTZ,
  actual_check_out_at TIMESTAMPTZ,
  final_payment NUMERIC DEFAULT 0,
  final_payment_mode TEXT,
  discounts JSONB DEFAULT '[]'::jsonb,
  discount_amount NUMERIC DEFAULT 0,
  additional_charges JSONB DEFAULT '[]'::jsonb,
  total_paid NUMERIC DEFAULT 0,
  checkout_notes TEXT,
  check_out_by TEXT,
  billing_complete BOOLEAN DEFAULT FALSE,
  booking_id TEXT,
  last_updated TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hotel_checkins_restaurant ON hotel_checkins (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_hotel_checkins_restaurant_status ON hotel_checkins (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_hotel_checkins_room ON hotel_checkins (restaurant_id, room_number);

-- ── Hotel Guests ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotel_guests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  zip_code TEXT,
  id_proof_type TEXT,
  id_proof_number TEXT,
  id_proof_image_url TEXT,
  gst_number TEXT,
  gst_company_name TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_hotel_guests_restaurant ON hotel_guests (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_hotel_guests_phone ON hotel_guests (restaurant_id, phone);

-- ── Room Maintenance Schedules ───────────────────────────────
CREATE TABLE IF NOT EXISTS room_maintenance_schedules (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  room_id TEXT,
  room_number TEXT,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  reason TEXT,
  status TEXT DEFAULT 'active',
  created_by TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_room_maintenance_restaurant ON room_maintenance_schedules (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_room_maintenance_room ON room_maintenance_schedules (restaurant_id, room_id);

-- ── PMS Rooms ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_rooms (
  id TEXT PRIMARY KEY,
  hotel_id TEXT,
  room_number TEXT,
  room_type TEXT,
  floor TEXT,
  status TEXT DEFAULT 'available',
  current_booking_id TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_rooms_hotel ON pms_rooms (hotel_id);

-- ── PMS Bookings ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_bookings (
  id TEXT PRIMARY KEY,
  hotel_id TEXT,
  room_id TEXT,
  room_number TEXT,
  guest_id TEXT,
  guest_name TEXT,
  status TEXT DEFAULT 'confirmed',
  check_in_date TEXT,
  check_out_date TEXT,
  checked_in_at TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_bookings_hotel ON pms_bookings (hotel_id);
CREATE INDEX IF NOT EXISTS idx_pms_bookings_guest ON pms_bookings (guest_id);

-- ── PMS Guests ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_guests (
  id TEXT PRIMARY KEY,
  hotel_id TEXT,
  name TEXT,
  phone TEXT,
  email TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_guests_hotel ON pms_guests (hotel_id);

-- ── PMS Housekeeping ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_housekeeping (
  id TEXT PRIMARY KEY,
  hotel_id TEXT,
  room_id TEXT,
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_housekeeping_hotel ON pms_housekeeping (hotel_id);

-- ── PMS Maintenance ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pms_maintenance (
  id TEXT PRIMARY KEY,
  hotel_id TEXT,
  room_id TEXT,
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pms_maintenance_hotel ON pms_maintenance (hotel_id);

-- ── Bookings V2 (catering/venue/advance_order) ──────────────
CREATE TABLE IF NOT EXISTS bookings_v2 (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  booking_number TEXT,
  type TEXT,
  customer JSONB,
  event_name TEXT,
  event_date TEXT,
  event_end_date TEXT,
  event_time TEXT,
  event_end_time TEXT,
  guest_count INTEGER DEFAULT 0,
  special_instructions TEXT,
  venue JSONB,
  items JSONB DEFAULT '[]'::jsonb,
  subtotal NUMERIC DEFAULT 0,
  discount JSONB,
  tax_amount NUMERIC DEFAULT 0,
  service_charge NUMERIC DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  payments JSONB DEFAULT '[]'::jsonb,
  paid_amount NUMERIC DEFAULT 0,
  balance_amount NUMERIC DEFAULT 0,
  payment_status TEXT DEFAULT 'unpaid',
  status TEXT DEFAULT 'confirmed',
  track_expense BOOLEAN DEFAULT FALSE,
  expense_created BOOLEAN DEFAULT FALSE,
  created_by JSONB,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_v2_restaurant ON bookings_v2 (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_v2_restaurant_status ON bookings_v2 (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_v2_event_date ON bookings_v2 (restaurant_id, event_date);

-- ── Booking Venues ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_venues (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT,
  capacity INTEGER DEFAULT 0,
  description TEXT,
  hourly_rate NUMERIC,
  fixed_rate NUMERIC,
  operating_hours JSONB,
  allow_multiple_bookings BOOLEAN DEFAULT FALSE,
  max_concurrent_bookings INTEGER DEFAULT 1,
  amenities JSONB DEFAULT '[]'::jsonb,
  sections JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  status TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_venues_restaurant ON booking_venues (restaurant_id);

-- ── Legacy Bookings (table reservations + catering) ──────────
CREATE TABLE IF NOT EXISTS legacy_bookings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  booking_number TEXT,
  type TEXT,
  customer JSONB,
  event_name TEXT,
  event_date TEXT,
  event_end_date TEXT,
  event_time TEXT,
  event_end_time TEXT,
  guest_count INTEGER DEFAULT 0,
  special_instructions TEXT,
  venue JSONB,
  items JSONB DEFAULT '[]'::jsonb,
  subtotal NUMERIC DEFAULT 0,
  discount JSONB,
  tax_amount NUMERIC DEFAULT 0,
  service_charge NUMERIC DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  payments JSONB DEFAULT '[]'::jsonb,
  paid_amount NUMERIC DEFAULT 0,
  balance_amount NUMERIC DEFAULT 0,
  payment_status TEXT DEFAULT 'unpaid',
  status TEXT DEFAULT 'confirmed',
  track_expense BOOLEAN DEFAULT FALSE,
  expense_created BOOLEAN DEFAULT FALSE,
  created_by JSONB,
  extra_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_legacy_bookings_restaurant ON legacy_bookings (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_legacy_bookings_restaurant_status ON legacy_bookings (restaurant_id, status);
`;

async function main() {
  console.log('Creating hotel + booking PG tables...');
  const statements = DDL.split(';').map(s => s.trim()).filter(s => s.length > 0);

  for (const stmt of statements) {
    try {
      await query(stmt);
      const match = stmt.match(/(?:CREATE TABLE|CREATE INDEX).*?(?:IF NOT EXISTS\s+)?(\S+)/i);
      if (match) console.log('  OK:', match[1]);
    } catch (err) {
      console.error('  ERROR:', err.message.substring(0, 120));
    }
  }

  // Verify
  const tables = [
    'hotel_rooms', 'hotel_bookings', 'hotel_checkins', 'hotel_guests',
    'room_maintenance_schedules', 'pms_rooms', 'pms_bookings', 'pms_guests',
    'pms_housekeeping', 'pms_maintenance', 'bookings_v2', 'booking_venues', 'legacy_bookings'
  ];
  for (const t of tables) {
    const r = await query(`SELECT COUNT(*) as c FROM ${t}`);
    console.log(`  ${t}: ${r.rows[0].c} rows`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
