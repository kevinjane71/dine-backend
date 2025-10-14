const { db, collections } = require('./firebase');

// Fix restaurant isActive field
async function fixRestaurantIsActive() {
  try {
    console.log('🔧 Fixing restaurant isActive field...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found to fix');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants to check`);
    
    let fixedCount = 0;
    
    for (const doc of snapshot.docs) {
      const restaurantData = doc.data();
      const restaurantId = doc.id;
      
      console.log(`\n🏢 Processing restaurant: ${restaurantData.name} (${restaurantId})`);
      console.log(`  Current isActive: ${restaurantData.isActive}`);
      
      // Update isActive if it's undefined or false
      if (restaurantData.isActive === undefined || restaurantData.isActive === false) {
        await db.collection(collections.restaurants).doc(restaurantId).update({
          isActive: true,
          updatedAt: new Date()
        });
        
        console.log(`✅ Updated isActive to true`);
        fixedCount++;
      } else {
        console.log(`✅ Already active`);
      }
    }
    
    console.log(`\n🎉 Fix completed!`);
    console.log(`✅ Fixed: ${fixedCount} restaurants`);
    
  } catch (error) {
    console.error('❌ Fix failed:', error);
  }
}

// Run fix if this script is executed directly
if (require.main === module) {
  fixRestaurantIsActive()
    .then(() => {
      console.log('Fix completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fix failed:', error);
      process.exit(1);
    });
}

module.exports = { fixRestaurantIsActive };

// Fix restaurant isActive field
async function fixRestaurantIsActive() {
  try {
    console.log('🔧 Fixing restaurant isActive field...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found to fix');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants to check`);
    
    let fixedCount = 0;
    
    for (const doc of snapshot.docs) {
      const restaurantData = doc.data();
      const restaurantId = doc.id;
      
      console.log(`\n🏢 Processing restaurant: ${restaurantData.name} (${restaurantId})`);
      console.log(`  Current isActive: ${restaurantData.isActive}`);
      
      // Update isActive if it's undefined or false
      if (restaurantData.isActive === undefined || restaurantData.isActive === false) {
        await db.collection(collections.restaurants).doc(restaurantId).update({
          isActive: true,
          updatedAt: new Date()
        });
        
        console.log(`✅ Updated isActive to true`);
        fixedCount++;
      } else {
        console.log(`✅ Already active`);
      }
    }
    
    console.log(`\n🎉 Fix completed!`);
    console.log(`✅ Fixed: ${fixedCount} restaurants`);
    
  } catch (error) {
    console.error('❌ Fix failed:', error);
  }
}

// Run fix if this script is executed directly
if (require.main === module) {
  fixRestaurantIsActive()
    .then(() => {
      console.log('Fix completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fix failed:', error);
      process.exit(1);
    });
}

module.exports = { fixRestaurantIsActive };
