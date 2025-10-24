#!/usr/bin/env node

/**
 * Debug all collections to find where tables are stored
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

async function debugAllCollections() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🔍 Debugging all collections for restaurant ${restaurantId}`);
  
  try {
    // Check floors collection
    console.log('\n📊 Checking floors collection...');
    const floorsSnapshot = await db.collection('floors')
      .where('restaurantId', '==', restaurantId)
      .get();
    
    console.log(`Found ${floorsSnapshot.size} floors`);
    floorsSnapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      console.log(`Floor ${index + 1}:`, {
        id: doc.id,
        name: data.name,
        restaurantId: data.restaurantId,
        hasTables: !!data.tables,
        tableCount: data.tables ? data.tables.length : 0
      });
    });
    
    // Check restaurants subcollections
    console.log('\n📊 Checking restaurants subcollections...');
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (restaurantDoc.exists) {
      console.log('Restaurant exists, checking subcollections...');
      
      // Check if there's a tables subcollection
      const tablesSubcollection = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('tables')
        .get();
      
      console.log(`Restaurant subcollection 'tables': ${tablesSubcollection.size} items`);
      
      // Check if there's a floors subcollection
      const floorsSubcollection = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .get();
      
      console.log(`Restaurant subcollection 'floors': ${floorsSubcollection.size} items`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the debug
if (require.main === module) {
  debugAllCollections()
    .then(() => {
      console.log('\n🏁 Debug completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Debug failed with error:', error);
      process.exit(1);
    });
}

module.exports = { debugAllCollections };
