#!/usr/bin/env node

/**
 * Test RAG system with table update queries
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

const EnhancedRAGService = require('./services/enhancedRAGService');

async function testTableUpdate() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  const userId = 'WXypQ2HUY9ZIFQag6qOa';
  
  console.log(`🧪 Testing table update for restaurant ${restaurantId}`);
  
  try {
    const ragService = new EnhancedRAGService();
    
    // Test table update query
    console.log('\n📋 Testing: "mark table 3 out of service"');
    const result = await ragService.processQuery('mark table 3 out of service', restaurantId, userId);
    console.log('Response:', result.response.response);
    console.log('Execution:', result.execution);
    
    // Test current status after update
    console.log('\n📋 Testing: "show available tables"');
    const result2 = await ragService.processQuery('show available tables', restaurantId, userId);
    console.log('Response:', result2.response.response);
    console.log('Execution:', result2.execution);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testTableUpdate()
    .then(() => {
      console.log('\n🏁 Table update test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testTableUpdate };



