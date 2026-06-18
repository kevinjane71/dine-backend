/**
 * Test script for ordersRepo.js
 * Run: DATABASE_URL="postgresql://..." node scripts/test-orders-repo.js
 */
const ordersRepo = require('../repos/ordersRepo');
const { toFirestoreObj, toPgRow } = require('../repos/fieldMapper');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${label}`);
  }
}

async function test() {
  console.log('=== TESTING ordersRepo.js ===\n');

  const testId = 'test_' + Date.now();
  const testId2 = 'test_' + (Date.now() + 1);
  const testId3 = 'test_' + (Date.now() + 2);

  const orderData = {
    restaurantId: 'rest_test_001',
    orderNumber: 'ORD-TEST-001',
    dailyOrderId: 42,
    orderType: 'dine-in',
    status: 'confirmed',
    tableNumber: 'A3',
    tableId: 'table_abc',
    floorId: 'floor_1',
    floorName: 'Ground Floor',
    items: [
      { menuItemId: 'item_1', name: 'Butter Chicken', quantity: 2, price: 350, total: 700, category: 'Main Course' },
      { menuItemId: 'item_2', name: 'Naan', quantity: 4, price: 50, total: 200, category: 'Breads' }
    ],
    subtotal: 900,
    totalAmount: 900,
    taxAmount: 45,
    taxBreakdown: [{ taxGroupId: 'gst5', taxRate: 5, taxAmount: 45 }],
    finalAmount: 945,
    discountAmount: 0,
    manualDiscount: 0,
    loyaltyDiscount: 0,
    totalDiscountAmount: 0,
    paymentMethod: 'cash',
    paymentStatus: 'pending',
    kotSent: false,
    customerInfo: { name: 'Rahul Kumar', phone: '+919876543210', email: 'rahul@test.com' },
    customerPhone: '+919876543210',
    customerName: 'Rahul Kumar',
    staffInfo: { userId: 'staff_1', name: 'Amit', role: 'waiter', phone: '9988776655' },
    notes: 'Extra spicy',
    specialInstructions: 'No onion',
    syncSource: 'online',
    createdAt: new Date(),
    updatedAt: new Date(),
    // Unmapped fields → should go to extra_data
    seatNumber: 'W-5',
    billingAudit: { feSubtotal: 900, beSubtotal: 900 },
  };

  // ---- TEST 1: create() ----
  console.log('1. create()');
  const created = await ordersRepo.create(testId, orderData);
  assert('Returns order with correct id', created.id === testId);
  assert('Items is array', Array.isArray(created.items));
  assert('Items count = 2', created.items.length === 2);
  assert('Item name correct', created.items[0].name === 'Butter Chicken');
  assert('finalAmount = 945', Number(created.finalAmount) === 945);
  assert('customerInfo.name', created.customerInfo.name === 'Rahul Kumar');
  assert('staffInfo.role', created.staffInfo.role === 'waiter');
  assert('Extra field: seatNumber preserved', created.seatNumber === 'W-5');
  assert('Extra field: billingAudit preserved', created.billingAudit && created.billingAudit.feSubtotal === 900);
  console.log('');

  // ---- TEST 2: getById() ----
  console.log('2. getById()');
  const fetched = await ordersRepo.getById(testId);
  assert('Found order', fetched !== null);
  assert('id matches', fetched.id === testId);
  assert('restaurantId', fetched.restaurantId === 'rest_test_001');
  assert('orderNumber', fetched.orderNumber === 'ORD-TEST-001');
  assert('dailyOrderId', fetched.dailyOrderId === 42);
  assert('tableNumber', fetched.tableNumber === 'A3');
  assert('status', fetched.status === 'confirmed');
  assert('items[0].name', fetched.items[0].name === 'Butter Chicken');
  assert('taxBreakdown[0].taxRate', fetched.taxBreakdown[0].taxRate === 5);
  assert('notes', fetched.notes === 'Extra spicy');
  assert('specialInstructions', fetched.specialInstructions === 'No onion');
  assert('seatNumber from extra_data', fetched.seatNumber === 'W-5');
  console.log('');

  // ---- TEST 3: getById() not found ----
  console.log('3. getById() not found');
  const notFound = await ordersRepo.getById('nonexistent_id_xyz');
  assert('Returns null for missing order', notFound === null);
  console.log('');

  // Create more test orders
  await ordersRepo.create(testId2, {
    ...orderData,
    dailyOrderId: 43,
    orderNumber: 'ORD-TEST-002',
    status: 'pending',
    paymentMethod: 'card',
    customerInfo: { name: 'Priya Sharma', phone: '+919123456789' },
    customerName: 'Priya Sharma',
    customerPhone: '+919123456789',
    tableNumber: 'B1',
  });

  await ordersRepo.create(testId3, {
    ...orderData,
    dailyOrderId: 44,
    orderNumber: 'ORD-TEST-003',
    status: 'completed',
    paymentStatus: 'paid',
    paymentMethod: 'upi',
  });

  // ---- TEST 4: getByRestaurant() basic pagination ----
  console.log('4. getByRestaurant() basic pagination');
  const list = await ordersRepo.getByRestaurant('rest_test_001', { page: 1, limit: 2 });
  assert('Returns orders array', Array.isArray(list.orders));
  assert('Respects limit', list.orders.length <= 2);
  assert('Total orders = 3', list.pagination.totalOrders === 3);
  assert('Total pages = 2', list.pagination.totalPages === 2);
  assert('Has next page', list.pagination.hasNextPage === true);
  assert('First order has items', Array.isArray(list.orders[0].items));
  console.log('');

  // ---- TEST 5: getByRestaurant() status filter ----
  console.log('5. getByRestaurant() status filter');
  const pendingList = await ordersRepo.getByRestaurant('rest_test_001', { status: 'pending' });
  assert('Returns pending orders', pendingList.orders.length === 1);
  assert('All are pending', pendingList.orders.every(o => o.status === 'pending'));
  console.log('');

  // ---- TEST 6: getByRestaurant() search by customer name ----
  console.log('6. getByRestaurant() search by name');
  const searchResult = await ordersRepo.getByRestaurant('rest_test_001', { search: 'Priya' });
  assert('Found 1 result', searchResult.orders.length === 1);
  const foundName = searchResult.orders[0].customerName || searchResult.orders[0].customerInfo?.name;
  assert('Correct customer', foundName === 'Priya Sharma');
  console.log('');

  // ---- TEST 7: getByRestaurant() search by dailyOrderId ----
  console.log('7. getByRestaurant() search by order number');
  const numSearch = await ordersRepo.getByRestaurant('rest_test_001', { search: '42' });
  assert('Found order #42', numSearch.orders.length >= 1);
  assert('Correct dailyOrderId', numSearch.orders[0].dailyOrderId === 42);
  console.log('');

  // ---- TEST 8: getByRestaurant() payment status filter ----
  console.log('8. getByRestaurant() payment status filter');
  const paidList = await ordersRepo.getByRestaurant('rest_test_001', { paymentStatus: 'paid' });
  assert('Found paid orders', paidList.orders.length === 1);
  console.log('');

  // ---- TEST 9: getKotOrders() ----
  console.log('9. getKotOrders()');
  const kotResult = await ordersRepo.getKotOrders('rest_test_001', {});
  assert('Returns orders', kotResult.orders.length > 0);
  assert('Total matches', kotResult.total === kotResult.orders.length);
  const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
  assert('All valid KOT statuses', kotResult.orders.every(o => validStatuses.includes(o.status)));
  console.log('');

  // ---- TEST 10: getKotOrders() status filter ----
  console.log('10. getKotOrders() status filter');
  const kotConfirmed = await ordersRepo.getKotOrders('rest_test_001', { status: 'confirmed' });
  assert('Filtered correctly', kotConfirmed.orders.every(o => o.status === 'confirmed'));
  console.log('');

  // ---- TEST 11: update() ----
  console.log('11. update()');
  const updated = await ordersRepo.update(testId, {
    items: [
      { menuItemId: 'item_1', name: 'Butter Chicken', quantity: 3, price: 350, total: 1050, category: 'Main Course', isUpdated: true },
      { menuItemId: 'item_2', name: 'Naan', quantity: 4, price: 50, total: 200, category: 'Breads' },
      { menuItemId: 'item_3', name: 'Raita', quantity: 1, price: 80, total: 80, category: 'Sides', isNew: true }
    ],
    subtotal: 1330,
    totalAmount: 1330,
    taxAmount: 66.50,
    finalAmount: 1396.50,
    kotSent: true,
    specialInstructions: 'Extra raita on the side',
  });
  assert('Items updated to 3', updated.items.length === 3);
  assert('New item present', updated.items.some(i => i.name === 'Raita'));
  assert('Quantity updated', updated.items.find(i => i.name === 'Butter Chicken').quantity === 3);
  assert('finalAmount updated', Number(updated.finalAmount) === 1396.5);
  assert('kotSent = true', updated.kotSent === true);
  assert('specialInstructions updated', updated.specialInstructions === 'Extra raita on the side');
  console.log('');

  // ---- TEST 12: updateStatus() → completed ----
  console.log('12. updateStatus() → completed');
  const statusUpdated = await ordersRepo.updateStatus(testId, 'completed', { customerId: 'cust_123' });
  assert('Status = completed', statusUpdated.status === 'completed');
  assert('lastStatus = confirmed', statusUpdated.lastStatus === 'confirmed');
  assert('completedAt set', statusUpdated.completedAt instanceof Date);
  assert('customerId set', statusUpdated.customerId === 'cust_123');
  console.log('');

  // ---- TEST 13: updateStatus() → cancelled ----
  console.log('13. updateStatus() → cancelled');
  const cancelled = await ordersRepo.updateStatus(testId2, 'cancelled', {
    cancelledBy: 'staff_1',
    cancellationReason: 'Customer left',
  });
  assert('Status = cancelled', cancelled.status === 'cancelled');
  assert('cancelledAt set', cancelled.cancelledAt instanceof Date);
  assert('cancelledBy', cancelled.cancelledBy === 'staff_1');
  assert('cancellationReason', cancelled.cancellationReason === 'Customer left');
  assert('lastStatus = pending', cancelled.lastStatus === 'pending');
  console.log('');

  // ---- TEST 14: round-trip mapping ----
  console.log('14. toPgRow / toFirestoreObj round-trip');
  const original = { restaurantId: 'r1', items: [{ name: 'test' }], status: 'pending', createdAt: new Date(), seatNumber: 'X1' };
  const pgRow = toPgRow(original);
  assert('toPgRow: restaurant_id mapped', pgRow.restaurant_id === 'r1');
  assert('toPgRow: extra_data has seatNumber', pgRow.extra_data && pgRow.extra_data.seatNumber === 'X1');
  const backToCamel = toFirestoreObj(pgRow);
  assert('toFirestoreObj: restaurantId restored', backToCamel.restaurantId === 'r1');
  assert('toFirestoreObj: seatNumber restored', backToCamel.seatNumber === 'X1');
  console.log('');

  // ---- CLEANUP ----
  console.log('Cleanup...');
  const { query: pgQuery } = require('../repos/pgClient');
  await pgQuery("DELETE FROM orders WHERE restaurant_id = 'rest_test_001'");
  const remaining = await pgQuery('SELECT count(*) FROM orders');
  console.log(`  Cleaned up. Rows remaining: ${remaining.rows[0].count}`);

  // Close pool
  const { getPool } = require('../repos/pgClient');
  await getPool().end();

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

test().catch(e => {
  console.error('TEST FAILED:', e.message, e.stack);
  process.exit(1);
});
