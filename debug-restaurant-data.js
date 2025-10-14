const { db, collections } = require('./firebase');

// Debug script to check restaurant data
async function debugRestaurantData() {
  try {
    console.log('🔍 Debugging restaurant data...');
    
    // Check if restaurant with subdomain "temp" exists
    const tempRestaurantSnapshot = await db.collection(collections.restaurants)
      .where('subdomain', '==', 'temp')
      .get();
    
    console.log(`📊 Found ${tempRestaurantSnapshot.size} restaurants with subdomain "temp"`);
    
    if (!tempRestaurantSnapshot.empty) {
      const restaurant = tempRestaurantSnapshot.docs[0];
      const restaurantData = restaurant.data();
      
      console.log('🏢 Restaurant data:');
      console.log('  ID:', restaurant.id);
      console.log('  Name:', restaurantData.name);
      console.log('  Subdomain:', restaurantData.subdomain);
      console.log('  Owner ID:', restaurantData.ownerId);
      console.log('  Is Active:', restaurantData.isActive);
      console.log('  Created At:', restaurantData.createdAt);
      
      // Check if owner exists
      const ownerSnapshot = await db.collection(collections.users)
        .doc(restaurantData.ownerId)
        .get();
      
      if (ownerSnapshot.exists) {
        const ownerData = ownerSnapshot.data();
        console.log('👤 Owner data:');
        console.log('  ID:', restaurantData.ownerId);
        console.log('  Phone:', ownerData.phone);
        console.log('  Name:', ownerData.name);
        console.log('  Role:', ownerData.role);
      } else {
        console.log('❌ Owner not found for ID:', restaurantData.ownerId);
      }
      
      // Check user-restaurant relationship
      const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
        .where('restaurantId', '==', restaurant.id)
        .get();
      
      console.log(`🔗 Found ${userRestaurantSnapshot.size} user-restaurant relationships`);
      userRestaurantSnapshot.forEach(doc => {
        const relationshipData = doc.data();
        console.log('  User ID:', relationshipData.userId);
        console.log('  Role:', relationshipData.role);
      });
      
    } else {
      console.log('❌ No restaurant found with subdomain "temp"');
    }
    
    // Check all restaurants for user with phone 90000000000
    console.log('\n🔍 Checking restaurants for phone 90000000000...');
    const userSnapshot = await db.collection(collections.users)
      .where('phone', '==', '90000000000')
      .get();
    
    if (!userSnapshot.empty) {
      const user = userSnapshot.docs[0];
      const userData = user.data();
      console.log('👤 User found:');
      console.log('  ID:', user.id);
      console.log('  Phone:', userData.phone);
      console.log('  Name:', userData.name);
      
      // Get restaurants for this user
      const userRestaurantsSnapshot = await db.collection(collections.restaurants)
        .where('ownerId', '==', user.id)
        .get();
      
      console.log(`🏢 User has ${userRestaurantsSnapshot.size} restaurants:`);
      userRestaurantsSnapshot.forEach(doc => {
        const restaurantData = doc.data();
        console.log(`  - ${restaurantData.name} (subdomain: ${restaurantData.subdomain})`);
      });
      
    } else {
      console.log('❌ No user found with phone 90000000000');
    }
    
  } catch (error) {
    console.error('❌ Debug error:', error);
  }
}

// Run debug if this script is executed directly
if (require.main === module) {
  debugRestaurantData()
    .then(() => {
      console.log('Debug completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Debug failed:', error);
      process.exit(1);
    });
}

module.exports = { debugRestaurantData };

// Debug script to check restaurant data
async function debugRestaurantData() {
  try {
    console.log('🔍 Debugging restaurant data...');
    
    // Check if restaurant with subdomain "temp" exists
    const tempRestaurantSnapshot = await db.collection(collections.restaurants)
      .where('subdomain', '==', 'temp')
      .get();
    
    console.log(`📊 Found ${tempRestaurantSnapshot.size} restaurants with subdomain "temp"`);
    
    if (!tempRestaurantSnapshot.empty) {
      const restaurant = tempRestaurantSnapshot.docs[0];
      const restaurantData = restaurant.data();
      
      console.log('🏢 Restaurant data:');
      console.log('  ID:', restaurant.id);
      console.log('  Name:', restaurantData.name);
      console.log('  Subdomain:', restaurantData.subdomain);
      console.log('  Owner ID:', restaurantData.ownerId);
      console.log('  Is Active:', restaurantData.isActive);
      console.log('  Created At:', restaurantData.createdAt);
      
      // Check if owner exists
      const ownerSnapshot = await db.collection(collections.users)
        .doc(restaurantData.ownerId)
        .get();
      
      if (ownerSnapshot.exists) {
        const ownerData = ownerSnapshot.data();
        console.log('👤 Owner data:');
        console.log('  ID:', restaurantData.ownerId);
        console.log('  Phone:', ownerData.phone);
        console.log('  Name:', ownerData.name);
        console.log('  Role:', ownerData.role);
      } else {
        console.log('❌ Owner not found for ID:', restaurantData.ownerId);
      }
      
      // Check user-restaurant relationship
      const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
        .where('restaurantId', '==', restaurant.id)
        .get();
      
      console.log(`🔗 Found ${userRestaurantSnapshot.size} user-restaurant relationships`);
      userRestaurantSnapshot.forEach(doc => {
        const relationshipData = doc.data();
        console.log('  User ID:', relationshipData.userId);
        console.log('  Role:', relationshipData.role);
      });
      
    } else {
      console.log('❌ No restaurant found with subdomain "temp"');
    }
    
    // Check all restaurants for user with phone 90000000000
    console.log('\n🔍 Checking restaurants for phone 90000000000...');
    const userSnapshot = await db.collection(collections.users)
      .where('phone', '==', '90000000000')
      .get();
    
    if (!userSnapshot.empty) {
      const user = userSnapshot.docs[0];
      const userData = user.data();
      console.log('👤 User found:');
      console.log('  ID:', user.id);
      console.log('  Phone:', userData.phone);
      console.log('  Name:', userData.name);
      
      // Get restaurants for this user
      const userRestaurantsSnapshot = await db.collection(collections.restaurants)
        .where('ownerId', '==', user.id)
        .get();
      
      console.log(`🏢 User has ${userRestaurantsSnapshot.size} restaurants:`);
      userRestaurantsSnapshot.forEach(doc => {
        const restaurantData = doc.data();
        console.log(`  - ${restaurantData.name} (subdomain: ${restaurantData.subdomain})`);
      });
      
    } else {
      console.log('❌ No user found with phone 90000000000');
    }
    
  } catch (error) {
    console.error('❌ Debug error:', error);
  }
}

// Run debug if this script is executed directly
if (require.main === module) {
  debugRestaurantData()
    .then(() => {
      console.log('Debug completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Debug failed:', error);
      process.exit(1);
    });
}

module.exports = { debugRestaurantData };




