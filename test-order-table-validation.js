#!/usr/bin/env node

/**
 * Test order creation with table validation using new structure
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

async function testOrderWithTableValidation() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🧪 Testing order creation with table validation for restaurant ${restaurantId}`);
  
  try {
    // Test 1: Create a floor and table
    console.log('\n📋 Test 1: Setting up test floor and table...');
    const floorId = 'floor_test_orders';
    const floorData = {
      name: 'Test Orders Floor',
      description: 'Test floor for order validation',
      restaurantId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .set(floorData);

    const tableData = {
      name: 'Test Order Table',
      floor: 'Test Orders Floor',
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

    console.log('✅ Test floor and table created successfully');

    // Test 2: Verify table validation logic (simulate what happens in order creation)
    console.log('\n📋 Test 2: Testing table validation logic...');
    const tableNumber = 'Test Order Table';
    
    // Simulate the validation logic from order creation
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();
    
    let tableFound = false;
    let tableStatus = null;
    let tableId = null;
    let tableFloor = null;
    
    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      for (const tableDoc of tablesSnapshot.docs) {
        const tableData = tableDoc.data();
        
        if (tableData.name && tableData.name.toString().toLowerCase() === tableNumber.trim().toLowerCase()) {
          tableFound = true;
          tableStatus = tableData.status;
          tableId = tableDoc.id;
          tableFloor = floorData.name;
          console.log('✅ Table validation passed:', { id: tableId, number: tableNumber, status: tableStatus, floor: tableFloor });
          break;
        }
      }
      
      if (tableFound) break;
    }

    if (!tableFound) {
      console.log('❌ Table validation failed - table not found');
      return;
    }

    if (tableStatus !== 'available') {
      console.log('❌ Table validation failed - table not available:', tableStatus);
      return;
    }

    console.log('✅ Table validation successful - table is available');

    // Test 3: Simulate table status update after order creation
    console.log('\n📋 Test 3: Testing table status update after order...');
    const mockOrderId = 'mock_order_123';
    
    // Find the table again and update its status
    const floorsSnapshot2 = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();
    
    let tableUpdated = false;
    for (const floorDoc of floorsSnapshot2.docs) {
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .where('name', '==', tableNumber.trim())
        .get();
      
      if (!tablesSnapshot.empty) {
        const tableDoc = tablesSnapshot.docs[0];
        await tableDoc.ref.update({
          status: 'occupied',
          currentOrderId: mockOrderId,
          lastOrderTime: new Date(),
          updatedAt: new Date()
        });
        console.log('✅ Table status updated to occupied');
        tableUpdated = true;
        break;
      }
    }

    if (!tableUpdated) {
      console.log('❌ Table status update failed');
      return;
    }

    // Test 4: Verify table is now occupied
    console.log('\n📋 Test 4: Verifying table is now occupied...');
    const updatedTableDoc = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .get();

    if (updatedTableDoc.exists) {
      const updatedTableData = updatedTableDoc.data();
      console.log('✅ Table status verification:', {
        name: updatedTableData.name,
        status: updatedTableData.status,
        currentOrderId: updatedTableData.currentOrderId
      });
    }

    // Test 5: Clean up
    console.log('\n📋 Test 5: Cleaning up test data...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .delete();

    console.log('✅ Test data cleaned up');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testOrderWithTableValidation()
    .then(() => {
      console.log('\n🏁 Order table validation test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testOrderWithTableValidation };



