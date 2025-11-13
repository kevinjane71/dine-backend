#!/usr/bin/env node

/**
 * Debug tables collection
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

async function debugTables() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🔍 Debugging tables collection for restaurant ${restaurantId}`);
  
  try {
    // Get all tables for this restaurant
    const tablesSnapshot = await db.collection('tables')
      .where('restaurantId', '==', restaurantId)
      .get();

    console.log(`📊 Found ${tablesSnapshot.size} tables in collection`);
    
    tablesSnapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      console.log(`📋 Table ${index + 1}:`, {
        id: doc.id,
        name: data.name,
        tableNumber: data.tableNumber,
        status: data.status,
        floor: data.floor,
        restaurantId: data.restaurantId
      });
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the debug
if (require.main === module) {
  debugTables()
    .then(() => {
      console.log('\n🏁 Debug completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Debug failed with error:', error);
      process.exit(1);
    });
}

module.exports = { debugTables };



