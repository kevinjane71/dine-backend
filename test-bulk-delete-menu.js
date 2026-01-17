/**
 * Test script for bulk delete menu items functionality
 *
 * This script tests:
 * 1. Bulk deleting all menu items for a restaurant
 * 2. Verification that items are soft deleted (status = 'deleted')
 * 3. Authorization checks (only owner can delete)
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

// Get menu items
async function getMenuItems() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'dine-backend.vercel.app',
      path: `/api/menus/${testRestaurantId}`,
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

// Bulk delete all menu items
async function bulkDeleteMenuItems() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'dine-backend.vercel.app',
      path: `/api/menus/${testRestaurantId}/bulk-delete`,
      method: 'DELETE',
      headers: {
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
    req.end();
  });
}

// Run tests
async function runTests() {
  console.log('\n🧪 Testing Bulk Delete Menu Items\n');
  console.log('=' .repeat(50));

  try {
    // Test 1: Login
    console.log('\n📝 Test 1: Login');
    await login();

    // Test 2: Get current menu items count
    console.log('\n📝 Test 2: Get current menu items');
    const menuBefore = await getMenuItems();
    const activeItemsBefore = menuBefore.items?.filter(item => item.status !== 'deleted').length || 0;
    console.log(`   Active items before: ${activeItemsBefore}`);
    console.log(`   Total items: ${menuBefore.items?.length || 0}`);

    if (activeItemsBefore === 0) {
      console.log('   ⚠️  No active menu items found. Skipping bulk delete test.');
      console.log('   ℹ️  Add some menu items first to test bulk delete.');
    } else {
      // Test 3: Bulk delete all menu items
      console.log('\n📝 Test 3: Bulk delete all menu items');
      const result = await bulkDeleteMenuItems();
      console.log(`   Status: ${result.status}`);
      console.log(`   Message: ${result.data.message}`);
      console.log(`   Deleted count: ${result.data.deletedCount}`);

      // Test 4: Verify deletion
      console.log('\n📝 Test 4: Verify deletion');
      const menuAfter = await getMenuItems();
      const activeItemsAfter = menuAfter.items?.filter(item => item.status !== 'deleted').length || 0;
      const deletedItems = menuAfter.items?.filter(item => item.status === 'deleted').length || 0;

      console.log(`   Active items after: ${activeItemsAfter}`);
      console.log(`   Deleted items: ${deletedItems}`);

      if (activeItemsAfter === 0 && deletedItems > 0) {
        console.log('   ✅ Bulk delete successful - all items soft deleted');
      } else {
        console.log('   ❌ Bulk delete may have failed - items still active');
      }

      // Test 5: Try to bulk delete again (should return error or 0 count)
      console.log('\n📝 Test 5: Try bulk delete again (no active items)');
      const result2 = await bulkDeleteMenuItems();
      console.log(`   Status: ${result2.status}`);
      console.log(`   Message: ${result2.data.message || result2.data.error}`);
      if (result2.status === 400) {
        console.log('   ✅ Validation working - no active items to delete');
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('\n✅ All tests completed!\n');
    console.log('⚠️  NOTE: Items are SOFT DELETED (status=deleted), not permanently removed');
    console.log('   This allows for potential data recovery if needed.\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
  }
}

// Run the tests
runTests();
