#!/usr/bin/env node

/**
 * Debug specific table IDs
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

async function debugSpecificTables() {
  const tableIds = ['BkHHyTb8pQMXrScn5PWb', 'm9BgOnjPqfk4wwuzj7tp', 'zU2BiXLf62CCIosbfYBO'];
  
  console.log(`🔍 Debugging specific table IDs`);
  
  try {
    for (const tableId of tableIds) {
      console.log(`\n📊 Checking table ${tableId}...`);
      
      const tableDoc = await db.collection('tables').doc(tableId).get();
      
      if (tableDoc.exists) {
        const data = tableDoc.data();
        console.log(`✅ Found table:`, {
          id: tableDoc.id,
          name: data.name,
          status: data.status,
          floor: data.floor,
          restaurantId: data.restaurantId
        });
      } else {
        console.log(`❌ Table ${tableId} not found`);
      }
    }
    
    // Also try a broader query
    console.log('\n📊 Checking all tables collection...');
    const allTablesSnapshot = await db.collection('tables').limit(10).get();
    console.log(`Found ${allTablesSnapshot.size} total tables in collection`);
    
    allTablesSnapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      console.log(`Table ${index + 1}:`, {
        id: doc.id,
        name: data.name,
        status: data.status,
        restaurantId: data.restaurantId
      });
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the debug
if (require.main === module) {
  debugSpecificTables()
    .then(() => {
      console.log('\n🏁 Debug completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Debug failed with error:', error);
      process.exit(1);
    });
}

module.exports = { debugSpecificTables };

