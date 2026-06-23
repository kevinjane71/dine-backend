/**
 * hotelBookingFieldMapper.js — camelCase (Firestore) <-> snake_case (PostgreSQL)
 * for hotel, PMS, and booking collections:
 *   rooms, hotel_bookings, hotel_checkins, hotel_guests, room_maintenance_schedules,
 *   pms-rooms, pms-bookings, pms-guests, pms-housekeeping, pms-maintenance,
 *   bookings_v2, booking_venues, bookings (legacy/catering)
 */

const { buildReverseMap, makeToPgRow, makeToFirestoreObj } = require('./queryBuilder');

// ── rooms (hotel rooms) ────────────────────────────────────────────────────

const ROOM_FIELD_MAP = {
  id:            'id',
  restaurantId:  'restaurant_id',
  roomNumber:    'room_number',
  type:          'type',
  floor:         'floor',
  capacity:      'capacity',
  amenities:     'amenities',
  tariff:        'tariff',
  status:        'status',
  currentGuest:  'current_guest',
  checkInId:     'check_in_id',
  createdAt:     'created_at',
  updatedAt:     'updated_at',
};

const ROOM_REVERSE_MAP = buildReverseMap(ROOM_FIELD_MAP);
const ROOM_JSONB_COLUMNS = new Set(['amenities', 'extra_data']);

// ── hotel_bookings ─────────────────────────────────────────────────────────

const HOTEL_BOOKING_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  roomId:              'room_id',
  roomNumber:          'room_number',
  guestName:           'guest_name',
  guestPhone:          'guest_phone',
  guestEmail:          'guest_email',
  checkInDate:         'check_in_date',
  checkOutDate:        'check_out_date',
  numberOfGuests:      'number_of_guests',
  stayDuration:        'stay_duration',
  estimatedTariff:     'estimated_tariff',
  totalAmount:         'total_amount',
  specialRequests:     'special_requests',
  bookingSource:       'booking_source',
  status:              'status',
  unavailableOverride: 'unavailable_override',
  cancellationReason:  'cancellation_reason',
  cancelledAt:         'cancelled_at',
  cancelledBy:         'cancelled_by',
  checkInId:           'check_in_id',
  checkedOutAt:        'checked_out_at',
  createdAt:           'created_at',
  updatedAt:           'updated_at',
};

const HOTEL_BOOKING_REVERSE_MAP = buildReverseMap(HOTEL_BOOKING_FIELD_MAP);
const HOTEL_BOOKING_JSONB_COLUMNS = new Set(['extra_data']);

// ── hotel_checkins ─────────────────────────────────────────────────────────

const HOTEL_CHECKIN_FIELD_MAP = {
  id:                'id',
  restaurantId:      'restaurant_id',
  guestId:           'guest_id',
  roomId:            'room_id',
  roomNumber:        'room_number',
  guestName:         'guest_name',
  guestPhone:        'guest_phone',
  guestEmail:        'guest_email',
  checkInDate:       'check_in_date',
  checkOutDate:      'check_out_date',
  stayDuration:      'stay_duration',
  numberOfGuests:    'number_of_guests',
  roomTariff:        'room_tariff',
  totalRoomCharges:  'total_room_charges',
  advancePayment:    'advance_payment',
  paymentMode:       'payment_mode',
  specialRequests:   'special_requests',
  status:            'status',
  foodOrders:        'food_orders',
  totalFoodCharges:  'total_food_charges',
  totalCharges:      'total_charges',
  balanceAmount:     'balance_amount',
  idProof:           'id_proof',
  gstInfo:           'gst_info',
  checkInBy:         'check_in_by',
  checkInAt:         'check_in_at',
  actualCheckOutAt:  'actual_check_out_at',
  finalPayment:      'final_payment',
  finalPaymentMode:  'final_payment_mode',
  discounts:         'discounts',
  discountAmount:    'discount_amount',
  additionalCharges: 'additional_charges',
  totalPaid:         'total_paid',
  checkoutNotes:     'checkout_notes',
  checkOutBy:        'check_out_by',
  billingComplete:   'billing_complete',
  bookingId:         'booking_id',
  lastUpdated:       'last_updated',
  createdAt:         'created_at',
  updatedAt:         'updated_at',
};

const HOTEL_CHECKIN_REVERSE_MAP = buildReverseMap(HOTEL_CHECKIN_FIELD_MAP);
const HOTEL_CHECKIN_JSONB_COLUMNS = new Set([
  'food_orders', 'id_proof', 'gst_info', 'discounts', 'additional_charges', 'extra_data',
]);

// ── hotel_guests ───────────────────────────────────────────────────────────

const HOTEL_GUEST_FIELD_MAP = {
  id:              'id',
  restaurantId:    'restaurant_id',
  name:            'name',
  phone:           'phone',
  email:           'email',
  address:         'address',
  city:            'city',
  state:           'state',
  country:         'country',
  zipCode:         'zip_code',
  idProofType:     'id_proof_type',
  idProofNumber:   'id_proof_number',
  idProofImageUrl: 'id_proof_image_url',
  gstNumber:       'gst_number',
  gstCompanyName:  'gst_company_name',
  createdAt:       'created_at',
  createdBy:       'created_by',
};

const HOTEL_GUEST_REVERSE_MAP = buildReverseMap(HOTEL_GUEST_FIELD_MAP);
const HOTEL_GUEST_JSONB_COLUMNS = new Set(['extra_data']);

// ── room_maintenance_schedules ─────────────────────────────────────────────

const ROOM_MAINTENANCE_FIELD_MAP = {
  id:           'id',
  restaurantId: 'restaurant_id',
  roomId:       'room_id',
  roomNumber:   'room_number',
  startDate:    'start_date',
  endDate:      'end_date',
  reason:       'reason',
  status:       'status',
  createdBy:    'created_by',
  createdAt:    'created_at',
  updatedAt:    'updated_at',
};

const ROOM_MAINTENANCE_REVERSE_MAP = buildReverseMap(ROOM_MAINTENANCE_FIELD_MAP);
const ROOM_MAINTENANCE_JSONB_COLUMNS = new Set(['extra_data']);

// ── pms-rooms ──────────────────────────────────────────────────────────────

const PMS_ROOM_FIELD_MAP = {
  id:               'id',
  hotelId:          'hotel_id',
  roomNumber:       'room_number',
  roomType:         'room_type',
  floor:            'floor',
  status:           'status',
  currentBookingId: 'current_booking_id',
  createdAt:        'created_at',
  updatedAt:        'updated_at',
};

const PMS_ROOM_REVERSE_MAP = buildReverseMap(PMS_ROOM_FIELD_MAP);
const PMS_ROOM_JSONB_COLUMNS = new Set(['extra_data']);

// ── pms-bookings ───────────────────────────────────────────────────────────

const PMS_BOOKING_FIELD_MAP = {
  id:            'id',
  hotelId:       'hotel_id',
  roomId:        'room_id',
  roomNumber:    'room_number',
  guestId:       'guest_id',
  guestName:     'guest_name',
  status:        'status',
  checkInDate:   'check_in_date',
  checkOutDate:  'check_out_date',
  checkedInAt:   'checked_in_at',
  checkedOutAt:  'checked_out_at',
  cancelledAt:   'cancelled_at',
  createdAt:     'created_at',
  updatedAt:     'updated_at',
};

const PMS_BOOKING_REVERSE_MAP = buildReverseMap(PMS_BOOKING_FIELD_MAP);
const PMS_BOOKING_JSONB_COLUMNS = new Set(['extra_data']);

// ── pms-guests ─────────────────────────────────────────────────────────────

const PMS_GUEST_FIELD_MAP = {
  id:        'id',
  hotelId:   'hotel_id',
  name:      'name',
  phone:     'phone',
  email:     'email',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PMS_GUEST_REVERSE_MAP = buildReverseMap(PMS_GUEST_FIELD_MAP);
const PMS_GUEST_JSONB_COLUMNS = new Set(['extra_data']);

// ── pms-housekeeping ───────────────────────────────────────────────────────

const PMS_HOUSEKEEPING_FIELD_MAP = {
  id:        'id',
  hotelId:   'hotel_id',
  roomId:    'room_id',
  status:    'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PMS_HOUSEKEEPING_REVERSE_MAP = buildReverseMap(PMS_HOUSEKEEPING_FIELD_MAP);
const PMS_HOUSEKEEPING_JSONB_COLUMNS = new Set(['extra_data']);

// ── pms-maintenance ────────────────────────────────────────────────────────

const PMS_MAINTENANCE_FIELD_MAP = {
  id:        'id',
  hotelId:   'hotel_id',
  roomId:    'room_id',
  status:    'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PMS_MAINTENANCE_REVERSE_MAP = buildReverseMap(PMS_MAINTENANCE_FIELD_MAP);
const PMS_MAINTENANCE_JSONB_COLUMNS = new Set(['extra_data']);

// ── bookings_v2 (catering/venue/advance_order) ────────────────────────────

const BOOKINGS_V2_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  bookingNumber:       'booking_number',
  type:                'type',
  customer:            'customer',
  eventName:           'event_name',
  eventDate:           'event_date',
  eventEndDate:        'event_end_date',
  eventTime:           'event_time',
  eventEndTime:        'event_end_time',
  guestCount:          'guest_count',
  specialInstructions: 'special_instructions',
  venue:               'venue',
  items:               'items',
  subtotal:            'subtotal',
  discount:            'discount',
  taxAmount:           'tax_amount',
  serviceCharge:       'service_charge',
  totalAmount:         'total_amount',
  payments:            'payments',
  paidAmount:          'paid_amount',
  balanceAmount:       'balance_amount',
  paymentStatus:       'payment_status',
  status:              'status',
  trackExpense:        'track_expense',
  expenseCreated:      'expense_created',
  createdBy:           'created_by',
  createdAt:           'created_at',
  updatedAt:           'updated_at',
  completedAt:         'completed_at',
  cancelledAt:         'cancelled_at',
  cancelReason:        'cancel_reason',
};

const BOOKINGS_V2_REVERSE_MAP = buildReverseMap(BOOKINGS_V2_FIELD_MAP);
const BOOKINGS_V2_JSONB_COLUMNS = new Set([
  'customer', 'venue', 'items', 'discount', 'payments', 'created_by', 'extra_data',
]);

// ── booking_venues ─────────────────────────────────────────────────────────

const BOOKING_VENUE_FIELD_MAP = {
  id:                      'id',
  restaurantId:            'restaurant_id',
  name:                    'name',
  capacity:                'capacity',
  description:             'description',
  hourlyRate:              'hourly_rate',
  fixedRate:               'fixed_rate',
  operatingHours:          'operating_hours',
  allowMultipleBookings:   'allow_multiple_bookings',
  maxConcurrentBookings:   'max_concurrent_bookings',
  amenities:               'amenities',
  sections:                'sections',
  isActive:                'is_active',
  status:                  'status',
  createdAt:               'created_at',
  updatedAt:               'updated_at',
};

const BOOKING_VENUE_REVERSE_MAP = buildReverseMap(BOOKING_VENUE_FIELD_MAP);
const BOOKING_VENUE_JSONB_COLUMNS = new Set(['operating_hours', 'amenities', 'sections', 'extra_data']);

// ── legacy bookings (table reservations + catering) ────────────────────────

const LEGACY_BOOKING_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  bookingNumber:       'booking_number',
  type:                'type',
  customer:            'customer',
  eventName:           'event_name',
  eventDate:           'event_date',
  eventEndDate:        'event_end_date',
  eventTime:           'event_time',
  eventEndTime:        'event_end_time',
  guestCount:          'guest_count',
  specialInstructions: 'special_instructions',
  venue:               'venue',
  items:               'items',
  subtotal:            'subtotal',
  discount:            'discount',
  taxAmount:           'tax_amount',
  serviceCharge:       'service_charge',
  totalAmount:         'total_amount',
  payments:            'payments',
  paidAmount:          'paid_amount',
  balanceAmount:       'balance_amount',
  paymentStatus:       'payment_status',
  status:              'status',
  trackExpense:        'track_expense',
  expenseCreated:      'expense_created',
  createdBy:           'created_by',
  createdAt:           'created_at',
  updatedAt:           'updated_at',
  completedAt:         'completed_at',
  cancelledAt:         'cancelled_at',
  cancelReason:        'cancel_reason',
};

const LEGACY_BOOKING_REVERSE_MAP = buildReverseMap(LEGACY_BOOKING_FIELD_MAP);
const LEGACY_BOOKING_JSONB_COLUMNS = new Set([
  'customer', 'venue', 'items', 'discount', 'payments', 'created_by', 'extra_data',
]);

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Rooms
  roomToPgRow:        makeToPgRow(ROOM_FIELD_MAP, ROOM_JSONB_COLUMNS),
  roomToFirestoreObj: makeToFirestoreObj(ROOM_REVERSE_MAP),
  ROOM_FIELD_MAP, ROOM_REVERSE_MAP, ROOM_JSONB_COLUMNS,

  // Hotel Bookings
  hotelBookingToPgRow:        makeToPgRow(HOTEL_BOOKING_FIELD_MAP, HOTEL_BOOKING_JSONB_COLUMNS),
  hotelBookingToFirestoreObj: makeToFirestoreObj(HOTEL_BOOKING_REVERSE_MAP),
  HOTEL_BOOKING_FIELD_MAP, HOTEL_BOOKING_REVERSE_MAP, HOTEL_BOOKING_JSONB_COLUMNS,

  // Hotel Checkins
  hotelCheckinToPgRow:        makeToPgRow(HOTEL_CHECKIN_FIELD_MAP, HOTEL_CHECKIN_JSONB_COLUMNS),
  hotelCheckinToFirestoreObj: makeToFirestoreObj(HOTEL_CHECKIN_REVERSE_MAP),
  HOTEL_CHECKIN_FIELD_MAP, HOTEL_CHECKIN_REVERSE_MAP, HOTEL_CHECKIN_JSONB_COLUMNS,

  // Hotel Guests
  hotelGuestToPgRow:        makeToPgRow(HOTEL_GUEST_FIELD_MAP, HOTEL_GUEST_JSONB_COLUMNS),
  hotelGuestToFirestoreObj: makeToFirestoreObj(HOTEL_GUEST_REVERSE_MAP),
  HOTEL_GUEST_FIELD_MAP, HOTEL_GUEST_REVERSE_MAP, HOTEL_GUEST_JSONB_COLUMNS,

  // Room Maintenance Schedules
  roomMaintenanceToPgRow:        makeToPgRow(ROOM_MAINTENANCE_FIELD_MAP, ROOM_MAINTENANCE_JSONB_COLUMNS),
  roomMaintenanceToFirestoreObj: makeToFirestoreObj(ROOM_MAINTENANCE_REVERSE_MAP),
  ROOM_MAINTENANCE_FIELD_MAP, ROOM_MAINTENANCE_REVERSE_MAP, ROOM_MAINTENANCE_JSONB_COLUMNS,

  // PMS Rooms
  pmsRoomToPgRow:        makeToPgRow(PMS_ROOM_FIELD_MAP, PMS_ROOM_JSONB_COLUMNS),
  pmsRoomToFirestoreObj: makeToFirestoreObj(PMS_ROOM_REVERSE_MAP),
  PMS_ROOM_FIELD_MAP, PMS_ROOM_REVERSE_MAP, PMS_ROOM_JSONB_COLUMNS,

  // PMS Bookings
  pmsBookingToPgRow:        makeToPgRow(PMS_BOOKING_FIELD_MAP, PMS_BOOKING_JSONB_COLUMNS),
  pmsBookingToFirestoreObj: makeToFirestoreObj(PMS_BOOKING_REVERSE_MAP),
  PMS_BOOKING_FIELD_MAP, PMS_BOOKING_REVERSE_MAP, PMS_BOOKING_JSONB_COLUMNS,

  // PMS Guests
  pmsGuestToPgRow:        makeToPgRow(PMS_GUEST_FIELD_MAP, PMS_GUEST_JSONB_COLUMNS),
  pmsGuestToFirestoreObj: makeToFirestoreObj(PMS_GUEST_REVERSE_MAP),
  PMS_GUEST_FIELD_MAP, PMS_GUEST_REVERSE_MAP, PMS_GUEST_JSONB_COLUMNS,

  // PMS Housekeeping
  pmsHousekeepingToPgRow:        makeToPgRow(PMS_HOUSEKEEPING_FIELD_MAP, PMS_HOUSEKEEPING_JSONB_COLUMNS),
  pmsHousekeepingToFirestoreObj: makeToFirestoreObj(PMS_HOUSEKEEPING_REVERSE_MAP),
  PMS_HOUSEKEEPING_FIELD_MAP, PMS_HOUSEKEEPING_REVERSE_MAP, PMS_HOUSEKEEPING_JSONB_COLUMNS,

  // PMS Maintenance
  pmsMaintenanceToPgRow:        makeToPgRow(PMS_MAINTENANCE_FIELD_MAP, PMS_MAINTENANCE_JSONB_COLUMNS),
  pmsMaintenanceToFirestoreObj: makeToFirestoreObj(PMS_MAINTENANCE_REVERSE_MAP),
  PMS_MAINTENANCE_FIELD_MAP, PMS_MAINTENANCE_REVERSE_MAP, PMS_MAINTENANCE_JSONB_COLUMNS,

  // Bookings V2
  bookingsV2ToPgRow:        makeToPgRow(BOOKINGS_V2_FIELD_MAP, BOOKINGS_V2_JSONB_COLUMNS),
  bookingsV2ToFirestoreObj: makeToFirestoreObj(BOOKINGS_V2_REVERSE_MAP),
  BOOKINGS_V2_FIELD_MAP, BOOKINGS_V2_REVERSE_MAP, BOOKINGS_V2_JSONB_COLUMNS,

  // Booking Venues
  bookingVenueToPgRow:        makeToPgRow(BOOKING_VENUE_FIELD_MAP, BOOKING_VENUE_JSONB_COLUMNS),
  bookingVenueToFirestoreObj: makeToFirestoreObj(BOOKING_VENUE_REVERSE_MAP),
  BOOKING_VENUE_FIELD_MAP, BOOKING_VENUE_REVERSE_MAP, BOOKING_VENUE_JSONB_COLUMNS,

  // Legacy Bookings
  legacyBookingToPgRow:        makeToPgRow(LEGACY_BOOKING_FIELD_MAP, LEGACY_BOOKING_JSONB_COLUMNS),
  legacyBookingToFirestoreObj: makeToFirestoreObj(LEGACY_BOOKING_REVERSE_MAP),
  LEGACY_BOOKING_FIELD_MAP, LEGACY_BOOKING_REVERSE_MAP, LEGACY_BOOKING_JSONB_COLUMNS,
};
