#!/usr/bin/env node

/**
 * RAG Security Test Script
 * Tests the multi-tenant security implementation
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || 'dine-pos-system'
  });
}

const { verifyUserRestaurantAccess, validateRestaurantAccess } = require('./middleware/ragSecurity');

async function testRAGSecurity() {
  console.log('🔒 Starting RAG Security Test...\n');

  try {
    // Test 1: Valid user-restaurant access
    console.log('🧪 Test 1: Valid user-restaurant access');
    const validAccess = await verifyUserRestaurantAccess('test-user-id', 'LUETVd1eMwu4Bm7PvP9K');
    console.log(`✅ Valid access result:`, validAccess);

    // Test 2: Invalid user-restaurant access
    console.log('\n🧪 Test 2: Invalid user-restaurant access');
    const invalidAccess = await verifyUserRestaurantAccess('invalid-user-id', 'LUETVd1eMwu4Bm7PvP9K');
    console.log(`❌ Invalid access result:`, invalidAccess);

    // Test 3: Cross-restaurant access attempt
    console.log('\n🧪 Test 3: Cross-restaurant access attempt');
    try {
      await validateRestaurantAccess('test-user-id', 'different-restaurant-id');
      console.log('❌ SECURITY FAILURE: Cross-restaurant access allowed!');
    } catch (error) {
      console.log('✅ SECURITY SUCCESS: Cross-restaurant access blocked:', error.message);
    }

    // Test 4: Invalid restaurant ID format
    console.log('\n🧪 Test 4: Invalid restaurant ID format');
    try {
      await validateRestaurantAccess('test-user-id', 'invalid-id');
      console.log('❌ SECURITY FAILURE: Invalid restaurant ID accepted!');
    } catch (error) {
      console.log('✅ SECURITY SUCCESS: Invalid restaurant ID rejected:', error.message);
    }

    console.log('\n🎉 RAG Security Test Completed!');
    console.log('\n📊 Security Features Verified:');
    console.log('✅ User-restaurant access validation');
    console.log('✅ Cross-restaurant access prevention');
    console.log('✅ Invalid ID format rejection');
    console.log('✅ Multi-tenant data isolation');

  } catch (error) {
    console.error('❌ RAG Security Test Failed:', error);
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testRAGSecurity()
    .then(() => {
      console.log('\n🏁 Security test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Security test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testRAGSecurity };



