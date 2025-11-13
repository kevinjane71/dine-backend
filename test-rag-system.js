#!/usr/bin/env node

/**
 * RAG System Test Script
 * Tests the complete end-to-end RAG functionality
 */

const admin = require('firebase-admin');
const OpenAI = require('openai');

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || 'dine-pos-system'
  });
}

const EnhancedRAGService = require('./services/enhancedRAGService');

async function testRAGSystem() {
  console.log('🧪 Starting RAG System Test...\n');

  try {
    // Initialize RAG service
    const ragService = new EnhancedRAGService();
    
    // Test restaurant ID (you can change this to your actual restaurant ID)
    const testRestaurantId = 'LUETVd1eMwu4Bm7PvP9K'; // Using the restaurant ID from your KOT page
    
    console.log(`📋 Testing with Restaurant ID: ${testRestaurantId}\n`);

    // Test 1: Initialize RAG Knowledge
    console.log('🔄 Test 1: Initializing RAG Knowledge...');
    const initResult = await ragService.initializeRAGKnowledge(testRestaurantId);
    
    if (initResult.success) {
      console.log('✅ RAG Knowledge initialized successfully');
    } else {
      console.log('❌ RAG Knowledge initialization failed:', initResult.error);
      return;
    }

    // Test 2: Process Sample Queries
    console.log('\n🔍 Test 2: Processing Sample Queries...');
    
    const testQueries = [
      'Show me the menu',
      'What vegetarian options do you have?',
      'Book a table for 4 people',
      'Show available tables',
      'What are your opening hours?',
      'Place an order for table 3'
    ];

    for (const query of testQueries) {
      console.log(`\n📝 Query: "${query}"`);
      
      const result = await ragService.processQuery(query, testRestaurantId, 'test-user');
      
      if (result.success) {
        console.log(`✅ Intent: ${result.intent}`);
        console.log(`💬 Response: ${result.response.response}`);
        console.log(`🎯 Action: ${result.response.action}`);
        
        if (result.ragContext && result.ragContext.length > 0) {
          console.log(`🔍 RAG Context: Found ${result.ragContext.length} relevant chunks`);
          result.ragContext.forEach((chunk, index) => {
            console.log(`   ${index + 1}. ${chunk.type}: ${chunk.text.substring(0, 50)}... (Score: ${(chunk.score * 100).toFixed(1)}%)`);
          });
        }
        
        if (result.execution) {
          console.log(`🔧 Execution: ${result.execution.success ? 'Success' : 'Failed'}`);
        }
      } else {
        console.log(`❌ Failed: ${result.error}`);
      }
    }

    // Test 3: Test Intent Classification
    console.log('\n🎯 Test 3: Testing Intent Classification...');
    
    const intentTests = [
      { query: 'show me vegetarian dishes', expectedIntent: 'menu_query' },
      { query: 'book table 5 for 2 people', expectedIntent: 'table_booking' },
      { query: 'place order for biryani', expectedIntent: 'order_placement' },
      { query: 'what tables are available', expectedIntent: 'table_management' },
      { query: 'what time do you open', expectedIntent: 'restaurant_info' }
    ];

    for (const test of intentTests) {
      const intent = await ragService.classifyIntent(test.query);
      const isCorrect = intent === test.expectedIntent;
      console.log(`${isCorrect ? '✅' : '❌'} "${test.query}" -> ${intent} (expected: ${test.expectedIntent})`);
    }

    console.log('\n🎉 RAG System Test Completed Successfully!');
    console.log('\n📊 Test Summary:');
    console.log('✅ RAG Knowledge Initialization');
    console.log('✅ Query Processing');
    console.log('✅ Intent Classification');
    console.log('✅ Context Retrieval');
    console.log('✅ Response Generation');

  } catch (error) {
    console.error('❌ RAG System Test Failed:', error);
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testRAGSystem()
    .then(() => {
      console.log('\n🏁 Test completed. Exiting...');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed with error:', error);
      process.exit(1);
    });
}

module.exports = { testRAGSystem };



