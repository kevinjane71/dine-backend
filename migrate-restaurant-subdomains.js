const { db, collections } = require('./firebase');
const { generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');

// Migration script to add subdomains to existing restaurants
async function migrateRestaurantsWithSubdomains() {
  try {
    console.log('🔄 Starting restaurant subdomain migration...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found to migrate');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants to check`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const doc of snapshot.docs) {
      const restaurantData = doc.data();
      const restaurantId = doc.id;
      
      console.log(`\n🏢 Processing restaurant: ${restaurantData.name} (${restaurantId})`);
      
      // Check if restaurant already has subdomain
      if (restaurantData.subdomain) {
        console.log(`✅ Already has subdomain: ${restaurantData.subdomain}`);
        skippedCount++;
        continue;
      }
      
      // Generate subdomain from restaurant name
      let subdomain = generateSubdomain(restaurantData.name);
      let subdomainCounter = 1;
      let finalSubdomain = subdomain;
      
      // Check if subdomain already exists and make it unique
      while (true) {
        const isAvailable = await isSubdomainAvailable(finalSubdomain);
        if (isAvailable) {
          break;
        }
        
        finalSubdomain = `${subdomain}-${subdomainCounter}`;
        subdomainCounter++;
      }
      
      console.log(`🔧 Generated subdomain: ${finalSubdomain}`);
      
      // Update restaurant with subdomain
      await db.collection(collections.restaurants).doc(restaurantId).update({
        subdomain: finalSubdomain,
        updatedAt: new Date()
      });
      
      console.log(`✅ Updated restaurant with subdomain: ${finalSubdomain}`);
      migratedCount++;
    }
    
    console.log(`\n🎉 Migration completed!`);
    console.log(`✅ Migrated: ${migratedCount} restaurants`);
    console.log(`⏭️ Skipped: ${skippedCount} restaurants (already had subdomains)`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateRestaurantsWithSubdomains()
    .then(() => {
      console.log('Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateRestaurantsWithSubdomains };
const { generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');

// Migration script to add subdomains to existing restaurants
async function migrateRestaurantsWithSubdomains() {
  try {
    console.log('🔄 Starting restaurant subdomain migration...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found to migrate');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants to check`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const doc of snapshot.docs) {
      const restaurantData = doc.data();
      const restaurantId = doc.id;
      
      console.log(`\n🏢 Processing restaurant: ${restaurantData.name} (${restaurantId})`);
      
      // Check if restaurant already has subdomain
      if (restaurantData.subdomain) {
        console.log(`✅ Already has subdomain: ${restaurantData.subdomain}`);
        skippedCount++;
        continue;
      }
      
      // Generate subdomain from restaurant name
      let subdomain = generateSubdomain(restaurantData.name);
      let subdomainCounter = 1;
      let finalSubdomain = subdomain;
      
      // Check if subdomain already exists and make it unique
      while (true) {
        const isAvailable = await isSubdomainAvailable(finalSubdomain);
        if (isAvailable) {
          break;
        }
        
        finalSubdomain = `${subdomain}-${subdomainCounter}`;
        subdomainCounter++;
      }
      
      console.log(`🔧 Generated subdomain: ${finalSubdomain}`);
      
      // Update restaurant with subdomain
      await db.collection(collections.restaurants).doc(restaurantId).update({
        subdomain: finalSubdomain,
        updatedAt: new Date()
      });
      
      console.log(`✅ Updated restaurant with subdomain: ${finalSubdomain}`);
      migratedCount++;
    }
    
    console.log(`\n🎉 Migration completed!`);
    console.log(`✅ Migrated: ${migratedCount} restaurants`);
    console.log(`⏭️ Skipped: ${skippedCount} restaurants (already had subdomains)`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateRestaurantsWithSubdomains()
    .then(() => {
      console.log('Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateRestaurantsWithSubdomains };
