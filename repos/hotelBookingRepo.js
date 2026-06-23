/**
 * hotelBookingRepo.js — PostgreSQL data access for hotel, PMS, and booking collections.
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
  roomToPgRow, roomToFirestoreObj, ROOM_JSONB_COLUMNS,
  hotelBookingToPgRow, hotelBookingToFirestoreObj, HOTEL_BOOKING_JSONB_COLUMNS,
  hotelCheckinToPgRow, hotelCheckinToFirestoreObj, HOTEL_CHECKIN_JSONB_COLUMNS,
  hotelGuestToPgRow, hotelGuestToFirestoreObj, HOTEL_GUEST_JSONB_COLUMNS,
  roomMaintenanceToPgRow, roomMaintenanceToFirestoreObj, ROOM_MAINTENANCE_JSONB_COLUMNS,
  pmsRoomToPgRow, pmsRoomToFirestoreObj, PMS_ROOM_JSONB_COLUMNS,
  pmsBookingToPgRow, pmsBookingToFirestoreObj, PMS_BOOKING_JSONB_COLUMNS,
  pmsGuestToPgRow, pmsGuestToFirestoreObj, PMS_GUEST_JSONB_COLUMNS,
  pmsHousekeepingToPgRow, pmsHousekeepingToFirestoreObj, PMS_HOUSEKEEPING_JSONB_COLUMNS,
  pmsMaintenanceToPgRow, pmsMaintenanceToFirestoreObj, PMS_MAINTENANCE_JSONB_COLUMNS,
  bookingsV2ToPgRow, bookingsV2ToFirestoreObj, BOOKINGS_V2_JSONB_COLUMNS,
  bookingVenueToPgRow, bookingVenueToFirestoreObj, BOOKING_VENUE_JSONB_COLUMNS,
  legacyBookingToPgRow, legacyBookingToFirestoreObj, LEGACY_BOOKING_JSONB_COLUMNS,
} = require('./hotelBookingFieldMapper');

// ── Generic helper ──────────────────────────────────────────────────────────

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

// ── Rooms (hotel rooms) ─────────────────────────────────────────────────────

const upsertRoom = makeUpsert('hotel_rooms', roomToPgRow, ROOM_JSONB_COLUMNS, roomToFirestoreObj);
const updateRoom = makeUpdate('hotel_rooms', roomToPgRow, ROOM_JSONB_COLUMNS);
const deleteRoom = makeDelete('hotel_rooms');

// ── Hotel Bookings ──────────────────────────────────────────────────────────

const upsertHotelBooking = makeUpsert('hotel_bookings', hotelBookingToPgRow, HOTEL_BOOKING_JSONB_COLUMNS, hotelBookingToFirestoreObj);
const updateHotelBooking = makeUpdate('hotel_bookings', hotelBookingToPgRow, HOTEL_BOOKING_JSONB_COLUMNS);

// ── Hotel Checkins ──────────────────────────────────────────────────────────

const upsertHotelCheckin = makeUpsert('hotel_checkins', hotelCheckinToPgRow, HOTEL_CHECKIN_JSONB_COLUMNS, hotelCheckinToFirestoreObj);
const updateHotelCheckin = makeUpdate('hotel_checkins', hotelCheckinToPgRow, HOTEL_CHECKIN_JSONB_COLUMNS);

// ── Hotel Guests ────────────────────────────────────────────────────────────

const upsertHotelGuest = makeUpsert('hotel_guests', hotelGuestToPgRow, HOTEL_GUEST_JSONB_COLUMNS, hotelGuestToFirestoreObj);

// ── Room Maintenance Schedules ──────────────────────────────────────────────

const upsertRoomMaintenance = makeUpsert('room_maintenance_schedules', roomMaintenanceToPgRow, ROOM_MAINTENANCE_JSONB_COLUMNS, roomMaintenanceToFirestoreObj);
const updateRoomMaintenance = makeUpdate('room_maintenance_schedules', roomMaintenanceToPgRow, ROOM_MAINTENANCE_JSONB_COLUMNS);

async function bulkUpdateMaintenanceByRoom(roomId, restaurantId, updates) {
  const pgRow = roomMaintenanceToPgRow(updates);
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const col of cols) {
    if (ROOM_MAINTENANCE_JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(typeof pgRow[col] === 'object' && pgRow[col] !== null ? JSON.stringify(pgRow[col]) : pgRow[col]);
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }
  values.push(roomId, restaurantId);
  await query(
    `UPDATE room_maintenance_schedules SET ${setClauses.join(', ')} WHERE room_id = $${i} AND restaurant_id = $${i + 1} AND status = 'active'`,
    values
  );
}

// ── PMS Rooms ───────────────────────────────────────────────────────────────

const upsertPmsRoom = makeUpsert('pms_rooms', pmsRoomToPgRow, PMS_ROOM_JSONB_COLUMNS, pmsRoomToFirestoreObj);
const updatePmsRoom = makeUpdate('pms_rooms', pmsRoomToPgRow, PMS_ROOM_JSONB_COLUMNS);
const deletePmsRoom = makeDelete('pms_rooms');

// ── PMS Bookings ────────────────────────────────────────────────────────────

const upsertPmsBooking = makeUpsert('pms_bookings', pmsBookingToPgRow, PMS_BOOKING_JSONB_COLUMNS, pmsBookingToFirestoreObj);
const updatePmsBooking = makeUpdate('pms_bookings', pmsBookingToPgRow, PMS_BOOKING_JSONB_COLUMNS);

// ── PMS Guests ──────────────────────────────────────────────────────────────

const upsertPmsGuest = makeUpsert('pms_guests', pmsGuestToPgRow, PMS_GUEST_JSONB_COLUMNS, pmsGuestToFirestoreObj);
const updatePmsGuest = makeUpdate('pms_guests', pmsGuestToPgRow, PMS_GUEST_JSONB_COLUMNS);
const deletePmsGuest = makeDelete('pms_guests');

// ── PMS Housekeeping ────────────────────────────────────────────────────────

const upsertPmsHousekeeping = makeUpsert('pms_housekeeping', pmsHousekeepingToPgRow, PMS_HOUSEKEEPING_JSONB_COLUMNS, pmsHousekeepingToFirestoreObj);
const updatePmsHousekeeping = makeUpdate('pms_housekeeping', pmsHousekeepingToPgRow, PMS_HOUSEKEEPING_JSONB_COLUMNS);
const deletePmsHousekeeping = makeDelete('pms_housekeeping');

// ── PMS Maintenance ─────────────────────────────────────────────────────────

const upsertPmsMaintenance = makeUpsert('pms_maintenance', pmsMaintenanceToPgRow, PMS_MAINTENANCE_JSONB_COLUMNS, pmsMaintenanceToFirestoreObj);
const updatePmsMaintenance = makeUpdate('pms_maintenance', pmsMaintenanceToPgRow, PMS_MAINTENANCE_JSONB_COLUMNS);
const deletePmsMaintenance = makeDelete('pms_maintenance');

// ── Bookings V2 ─────────────────────────────────────────────────────────────

const upsertBookingV2 = makeUpsert('bookings_v2', bookingsV2ToPgRow, BOOKINGS_V2_JSONB_COLUMNS, bookingsV2ToFirestoreObj);
const updateBookingV2 = makeUpdate('bookings_v2', bookingsV2ToPgRow, BOOKINGS_V2_JSONB_COLUMNS);

// ── Booking Venues ──────────────────────────────────────────────────────────

const upsertBookingVenue = makeUpsert('booking_venues', bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS, bookingVenueToFirestoreObj);
const updateBookingVenue = makeUpdate('booking_venues', bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS);
const deleteBookingVenue = makeDelete('booking_venues');

// ── Legacy Bookings ─────────────────────────────────────────────────────────

const upsertLegacyBooking = makeUpsert('legacy_bookings', legacyBookingToPgRow, LEGACY_BOOKING_JSONB_COLUMNS, legacyBookingToFirestoreObj);
const updateLegacyBooking = makeUpdate('legacy_bookings', legacyBookingToPgRow, LEGACY_BOOKING_JSONB_COLUMNS);

module.exports = {
  // Rooms
  upsertRoom, updateRoom, deleteRoom,
  // Hotel Bookings
  upsertHotelBooking, updateHotelBooking,
  // Hotel Checkins
  upsertHotelCheckin, updateHotelCheckin,
  // Hotel Guests
  upsertHotelGuest,
  // Room Maintenance
  upsertRoomMaintenance, updateRoomMaintenance, bulkUpdateMaintenanceByRoom,
  // PMS
  upsertPmsRoom, updatePmsRoom, deletePmsRoom,
  upsertPmsBooking, updatePmsBooking,
  upsertPmsGuest, updatePmsGuest, deletePmsGuest,
  upsertPmsHousekeeping, updatePmsHousekeeping, deletePmsHousekeeping,
  upsertPmsMaintenance, updatePmsMaintenance, deletePmsMaintenance,
  // Bookings V2
  upsertBookingV2, updateBookingV2,
  // Booking Venues
  upsertBookingVenue, updateBookingVenue, deleteBookingVenue,
  // Legacy Bookings
  upsertLegacyBooking, updateLegacyBooking,
};
