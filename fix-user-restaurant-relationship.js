#!/usr/bin/env node

/**
 * Fix user-restaurant relationship script
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

async function createUserRestaurantRelationship() {
  const userId = 'WXypQ2HUY9ZIFQag6qOa';
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  
  console.log(`🔧 Creating user-restaurant relationship for userId=${userId}, restaurantId=${restaurantId}`);
  
  try {
    // Check if relationship already exists
    const existingRelationship = await db.collection('userRestaurants')
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .get();

    if (!existingRelationship.empty) {
      console.log('✅ User-restaurant relationship already exists');
      existingRelationship.docs.forEach((doc, index) => {
        console.log(`📋 Existing Record ${index + 1}:`, doc.data());
      });
      return;
    }

    // Create the relationship
    const relationshipData = {
      userId: userId,
      restaurantId: restaurantId,
      role: 'owner',
      permissions: ['read', 'write', 'admin', 'rag_access', 'orders', 'menu', 'tables', 'analytics', 'inventory', 'customers'],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('userRestaurants').add(relationshipData);
    
    console.log(`✅ User-restaurant relationship created successfully!`);
    console.log(`📋 Document ID: ${docRef.id}`);
    console.log(`📋 Relationship Data:`, relationshipData);

    // Verify the relationship was created
    const verification = await db.collection('userRestaurants')
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .get();

    console.log(`🔍 Verification: Found ${verification.size} relationship records`);
    
  } catch (error) {
    console.error('❌ Error creating user-restaurant relationship:', error);
  }
}

// Run the fix
if (require.main === module) {
  createUserRestaurantRelationship()
    .then(() => {
      console.log('\n🏁 User-restaurant relationship fix completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Fix failed with error:', error);
      process.exit(1);
    });
}

module.exports = { createUserRestaurantRelationship };



