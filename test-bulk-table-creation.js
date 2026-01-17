/**
 * Test script for bulk table creation functionality
 *
 * This script tests:
 * 1. Bulk creating tables with sequential numbering
 * 2. Duplicate prevention (skipping existing tables)
 * 3. Auto-floor creation
 */

const https = require('https');

// Test configuration
const API_BASE_URL = 'https://dine-backend.vercel.app';
const TEST_PHONE = '+919000000000'; // Demo account
const TEST_PASSWORD = 'demo123';

let authToken = '';
let testRestaurantId = '';

// Login to get auth token
async function login() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      phone: TEST_PHONE,
      password: TEST_PASSWORD
    });

    const options = {
      hostname: 'dine-backend.vercel.app',
      path: '/api/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.token) {
            authToken = response.token;
            testRestaurantId = response.user.restaurantId;
            console.log('✅ Login successful');
            console.log(`   Restaurant ID: ${testRestaurantId}`);
            resolve();
          } else {
            reject(new Error('No token received'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Bulk create tables
async function bulkCreateTables(floor, fromNumber, toNumber, capacity = 4) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      floor,
      fromNumber,
      toNumber,
      capacity
    });

    const options = {
      hostname: 'dine-backend.vercel.app',
      path: `/api/tables/${testRestaurantId}/bulk`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Authorization': `Bearer ${authToken}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve({ status: res.statusCode, data: response });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Get all floors and tables
async function getFloors() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'dine-backend.vercel.app',
      path: `/api/floors/${testRestaurantId}`,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Run tests
async function runTests() {
  console.log('\n🧪 Testing Bulk Table Creation\n');
  console.log('=' .repeat(50));

  try {
    // Test 1: Login
    console.log('\n📝 Test 1: Login');
    await login();

    // Test 2: Create tables 1-10 on Test Floor
    console.log('\n📝 Test 2: Bulk create tables 1-10 on "Test Floor"');
    const result1 = await bulkCreateTables('Test Floor', 1, 10, 4);
    console.log(`   Status: ${result1.status}`);
    console.log(`   Created: ${result1.data.created} tables`);
    console.log(`   Skipped: ${result1.data.skipped} duplicates`);
    if (result1.data.skippedTables && result1.data.skippedTables.length > 0) {
      console.log(`   Skipped tables: ${result1.data.skippedTables.join(', ')}`);
    }

    // Test 3: Try to create overlapping range (should skip duplicates)
    console.log('\n📝 Test 3: Bulk create tables 5-15 (should skip 5-10)');
    const result2 = await bulkCreateTables('Test Floor', 5, 15, 4);
    console.log(`   Status: ${result2.status}`);
    console.log(`   Created: ${result2.data.created} tables`);
    console.log(`   Skipped: ${result2.data.skipped} duplicates`);
    if (result2.data.skippedTables && result2.data.skippedTables.length > 0) {
      console.log(`   Skipped tables: ${result2.data.skippedTables.join(', ')}`);
    }

    // Test 4: Verify all tables created
    console.log('\n📝 Test 4: Verify all tables');
    const floors = await getFloors();
    const testFloor = floors.floors?.find(f => f.name === 'Test Floor');
    if (testFloor) {
      console.log(`   ✅ Test Floor exists with ${testFloor.tables?.length || 0} tables`);
      const tableNames = testFloor.tables?.map(t => t.name).sort((a, b) => parseInt(a) - parseInt(b));
      console.log(`   Tables: ${tableNames?.join(', ')}`);
    } else {
      console.log('   ❌ Test Floor not found');
    }

    // Test 5: Test validation (from > to)
    console.log('\n📝 Test 5: Test validation (from > to)');
    const result3 = await bulkCreateTables('Test Floor', 20, 10, 4);
    console.log(`   Status: ${result3.status}`);
    if (result3.status === 400) {
      console.log(`   ✅ Validation working: ${result3.data.error}`);
    } else {
      console.log('   ❌ Validation failed');
    }

    // Test 6: Test max limit (> 100 tables)
    console.log('\n📝 Test 6: Test max limit validation');
    const result4 = await bulkCreateTables('Test Floor', 1, 200, 4);
    console.log(`   Status: ${result4.status}`);
    if (result4.status === 400) {
      console.log(`   ✅ Max limit validation working: ${result4.data.error}`);
    } else {
      console.log('   ❌ Max limit validation failed');
    }

    console.log('\n' + '='.repeat(50));
    console.log('\n✅ All tests completed!\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
  }
}

// Run the tests
runTests();
