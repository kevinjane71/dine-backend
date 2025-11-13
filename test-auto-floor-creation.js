#!/usr/bin/env node

/**
 * Test the auto-creation of floors when adding tables
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

async function testAutoFloorCreation() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🧪 Testing auto-creation of floors for restaurant ${restaurantId}`);
  
  try {
    // Test 1: Check if floors exist
    console.log('\n📋 Test 1: Checking existing floors...');
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    console.log(`Found ${floorsSnapshot.size} existing floors`);
    
    if (floorsSnapshot.size > 0) {
      floorsSnapshot.docs.forEach(floorDoc => {
        const floorData = floorDoc.data();
        console.log(`- Floor: ${floorData.name} (${floorDoc.id})`);
      });
    }

    // Test 2: Simulate adding a table to "Ground Floor" (should auto-create if not exists)
    console.log('\n📋 Test 2: Simulating table creation on "Ground Floor"...');
    
    const floorId = 'floor_ground_floor';
    let floorDoc = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .get();

    if (!floorDoc.exists) {
      console.log('🔄 Auto-creating "Ground Floor"...');
      const floorData = {
        name: 'Ground Floor',
        description: 'Auto-created floor: Ground Floor',
        restaurantId,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorId)
        .set(floorData);

      console.log('✅ Ground Floor created successfully');
    } else {
      console.log('✅ Ground Floor already exists');
    }

    // Test 3: Add a test table to Ground Floor
    console.log('\n📋 Test 3: Adding test table to Ground Floor...');
    const tableData = {
      name: 'Test Table Auto',
      floor: 'Ground Floor',
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

    console.log('✅ Test table added successfully');

    // Test 4: Verify the structure
    console.log('\n📋 Test 4: Verifying final structure...');
    const finalFloorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    console.log(`Final structure has ${finalFloorsSnapshot.size} floors:`);
    
    for (const floorDoc of finalFloorsSnapshot.docs) {
      const floorData = floorDoc.data();
      console.log(`- Floor: ${floorData.name}`);
      
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      console.log(`  - ${tablesSnapshot.size} tables`);
      tablesSnapshot.docs.forEach(tableDoc => {
        const tableData = tableDoc.data();
        console.log(`    * Table ${tableData.name}: ${tableData.status}`);
      });
    }

    // Test 5: Clean up test table
    console.log('\n📋 Test 5: Cleaning up test table...');
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .doc(tableRef.id)
      .delete();

    console.log('✅ Test table cleaned up');

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testAutoFloorCreation()
    .then(() => {
      console.log('\n🏁 Auto-creation test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testAutoFloorCreation };



