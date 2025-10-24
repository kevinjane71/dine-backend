#!/usr/bin/env node

/**
 * Debug script to check user-restaurant relationships
 */

const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin using the same pattern as the main app
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

async function checkUserRestaurantAccess() {
  const userId = 'WXypQ2HUY9ZIFQag6qOa';
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🔍 Checking user-restaurant access for userId=${userId}, restaurantId=${restaurantId}`);
  
  try {
    // Check userRestaurants collection
    const userRestaurantSnapshot = await db.collection('userRestaurants')
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .get();

    console.log(`📊 Found ${userRestaurantSnapshot.size} userRestaurants records`);
    
    if (!userRestaurantSnapshot.empty) {
      userRestaurantSnapshot.docs.forEach((doc, index) => {
        console.log(`📋 Record ${index + 1}:`, doc.data());
      });
    } else {
      console.log('❌ No userRestaurants records found');
      
      // Let's check if there are any records for this user at all
      const allUserRecords = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .get();
      
      console.log(`🔍 Found ${allUserRecords.size} total records for this user`);
      allUserRecords.docs.forEach((doc, index) => {
        console.log(`📋 User Record ${index + 1}:`, doc.data());
      });
      
      // Let's also check if there are any records for this restaurant
      const allRestaurantRecords = await db.collection('userRestaurants')
        .where('restaurantId', '==', restaurantId)
        .get();
      
      console.log(`🔍 Found ${allRestaurantRecords.size} total records for this restaurant`);
      allRestaurantRecords.docs.forEach((doc, index) => {
        console.log(`📋 Restaurant Record ${index + 1}:`, doc.data());
      });
    }
    
    // Also check the restaurant document itself
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (restaurantDoc.exists) {
      const restaurantData = restaurantDoc.data();
      console.log(`🏪 Restaurant data:`, {
        id: restaurantDoc.id,
        name: restaurantData.name,
        ownerId: restaurantData.ownerId,
        hasOwnerId: !!restaurantData.ownerId
      });
    } else {
      console.log('❌ Restaurant document does not exist');
      
      // Let's check if there are any restaurants at all
      const allRestaurants = await db.collection('restaurants').limit(10).get();
      console.log(`🔍 Found ${allRestaurants.size} total restaurants in database`);
      allRestaurants.docs.forEach((doc, index) => {
        const data = doc.data();
        console.log(`🏪 Restaurant ${index + 1}:`, {
          id: doc.id,
          name: data.name,
          ownerId: data.ownerId
        });
      });
      
      // Let's specifically search for our restaurant ID
      console.log(`🔍 Searching specifically for restaurant ${restaurantId}...`);
      const specificRestaurant = await db.collection('restaurants').doc(restaurantId).get();
      if (specificRestaurant.exists) {
        console.log(`✅ Found specific restaurant:`, specificRestaurant.data());
      } else {
        console.log(`❌ Specific restaurant ${restaurantId} not found`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking user-restaurant access:', error);
  }
}

// Run the check
if (require.main === module) {
  checkUserRestaurantAccess()
    .then(() => {
      console.log('\n🏁 Check completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Check failed with error:', error);
      process.exit(1);
    });
}

module.exports = { checkUserRestaurantAccess };
