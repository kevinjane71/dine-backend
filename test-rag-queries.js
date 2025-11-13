#!/usr/bin/env node

/**
 * Test RAG system with table queries
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

async function testRAGSystem() {
  const restaurantId = 'ZumnhNz0i8YTKFERbvOy';
  const userId = 'WXypQ2HUY9ZIFQag6qOa';
  
  console.log(`🧪 Testing RAG system for restaurant ${restaurantId}`);
  
  try {
    const ragService = new EnhancedRAGService();
    
    // Test table query
    console.log('\n📋 Testing: "How many total tables are there?"');
    const result1 = await ragService.processQuery('How many total tables are there?', restaurantId, userId);
    console.log('Response:', result1.response.response);
    console.log('Execution:', result1.execution);
    
    // Test available tables query
    console.log('\n📋 Testing: "Show available tables"');
    const result2 = await ragService.processQuery('Show available tables', restaurantId, userId);
    console.log('Response:', result2.response.response);
    console.log('Execution:', result2.execution);
    
    // Test orders query
    console.log('\n📋 Testing: "How many orders today?"');
    const result3 = await ragService.processQuery('How many orders today?', restaurantId, userId);
    console.log('Response:', result3.response.response);
    console.log('Execution:', result3.execution);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
if (require.main === module) {
  testRAGSystem()
    .then(() => {
      console.log('\n🏁 RAG system test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testRAGSystem };



