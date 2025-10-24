#!/usr/bin/env node

/**
 * Test all table operations with the new restaurant-centric structure
 */

const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin
if (!admin.apps.length) {
  const { initializeApp, cert } = require('firebase-admin/app');
  
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    })
  });
  
  console.log('✅ Firebase Admin initialized successfully');
}

const db = admin.firestore(undefined, 'dine');

async function testAllTableOperations() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🧪 Testing all table operations for restaurant ${restaurantId}`);
  
  try {
    // Test 1: Create a floor
    console.log('\n📋 Test 1: Creating a floor...');
    const floorId = 'floor_test_operations';
    const floorData = {
      name: 'Test Operations Floor',
      description: 'Test floor for all operations',
      restaurantId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .set(floorData);

    console.log('✅ Floor created successfully');

    // Test 2: Create a table
    console.log('\n📋 Test 2: Creating a table...');
    const tableData = {
      name: 'Test Table Operations',
      floor: 'Test Operations Floor',
      capacity: 4,
      section: 'Main',
      status: 'available',
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .add(tableData);

    console.log('✅ Table created successfully');

    // Test 3: Update table status (simulate PATCH /api/tables/:id/status)
    console.log('\n📋 Test 3: Updating table status...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .update({
        status: 'occupied',
        currentOrderId: 'order123',
        lastOrderTime: new Date(),
        updatedAt: new Date()
      });

    console.log('✅ Table status updated successfully');

    // Test 4: Update table details (simulate PATCH /api/tables/:id)
    console.log('\n📋 Test 4: Updating table details...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .update({
        name: 'Updated Test Table',
        capacity: 6,
        updatedAt: new Date()
      });

    console.log('✅ Table details updated successfully');

    // Test 5: Verify all changes
    console.log('\n📋 Test 5: Verifying all changes...');
    const updatedTableDoc = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .get();

    if (updatedTableDoc.exists) {
      const updatedTableData = updatedTableDoc.data();
      console.log('✅ Final table state:');
      console.log(`  - Name: ${updatedTableData.name}`);
      console.log(`  - Status: ${updatedTableData.status}`);
      console.log(`  - Capacity: ${updatedTableData.capacity}`);
      console.log(`  - Order ID: ${updatedTableData.currentOrderId}`);
    }

    // Test 6: Delete table (simulate DELETE /api/tables/:id)
    console.log('\n📋 Test 6: Deleting table...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .delete();

    console.log('✅ Table deleted successfully');

    // Test 7: Clean up floor
    console.log('\n📋 Test 7: Cleaning up floor...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .delete();

    console.log('✅ Floor cleaned up successfully');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testAllTableOperations()
    .then(() => {
      console.log('\n🏁 All table operations test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testAllTableOperations };
