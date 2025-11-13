#!/usr/bin/env node

/**
 * Test the new restaurant-centric table structure
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

async function testNewStructure() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🧪 Testing new restaurant-centric structure for restaurant ${restaurantId}`);
  
  try {
    // Test 1: Create a floor
    console.log('\n📋 Test 1: Creating a floor...');
    const floorId = 'floor_test_floor';
    const floorData = {
      name: 'Test Floor',
      description: 'Test floor for new structure',
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

    // Test 2: Create tables in the floor
    console.log('\n📋 Test 2: Creating tables in the floor...');
    const tableData1 = {
      name: 'Test Table 1',
      floor: 'Test Floor',
      capacity: 4,
      section: 'Main',
      status: 'available',
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableData2 = {
      name: 'Test Table 2',
      floor: 'Test Floor',
      capacity: 6,
      section: 'Main',
      status: 'occupied',
      currentOrderId: 'order123',
      lastOrderTime: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef1 = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .add(tableData1);

    const tableRef2 = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .add(tableData2);

    console.log('✅ Tables created successfully');

    // Test 3: Read the data back
    console.log('\n📋 Test 3: Reading data back...');
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    console.log(`Found ${floorsSnapshot.size} floors`);
    
    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      console.log(`Floor: ${floorData.name}`);
      
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      console.log(`  - ${tablesSnapshot.size} tables`);
      tablesSnapshot.docs.forEach(tableDoc => {
        const tableData = tableDoc.data();
        console.log(`    * Table ${tableData.name}: ${tableData.status} (${tableData.capacity} seats)`);
      });
    }

    // Test 4: Clean up test data
    console.log('\n📋 Test 4: Cleaning up test data...');
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
  testNewStructure()
    .then(() => {
      console.log('\n🏁 New structure test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testNewStructure };



