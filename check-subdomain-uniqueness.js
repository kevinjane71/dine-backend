const { db, collections } = require('./firebase');

// Check subdomain uniqueness
async function checkSubdomainUniqueness() {
  try {
    console.log('🔍 Checking subdomain uniqueness...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants`);
    
    const subdomainMap = new Map();
    const duplicates = [];
    
    snapshot.docs.forEach(doc => {
      const restaurantData = doc.data();
      const subdomain = restaurantData.subdomain;
      
      if (subdomain) {
        if (subdomainMap.has(subdomain)) {
          duplicates.push({
            subdomain,
            restaurant1: subdomainMap.get(subdomain),
            restaurant2: {
              id: doc.id,
              name: restaurantData.name
            }
          });
        } else {
          subdomainMap.set(subdomain, {
            id: doc.id,
            name: restaurantData.name
          });
        }
      }
    });
    
    console.log(`\n📋 Subdomain Summary:`);
    console.log(`  Total subdomains: ${subdomainMap.size}`);
    console.log(`  Duplicates found: ${duplicates.length}`);
    
    if (duplicates.length > 0) {
      console.log(`\n❌ Duplicate subdomains found:`);
      duplicates.forEach(dup => {
        console.log(`  Subdomain: ${dup.subdomain}`);
        console.log(`    Restaurant 1: ${dup.restaurant1.name} (${dup.restaurant1.id})`);
        console.log(`    Restaurant 2: ${dup.restaurant2.name} (${dup.restaurant2.id})`);
      });
    } else {
      console.log(`\n✅ All subdomains are unique!`);
    }
    
    // Show all subdomains
    console.log(`\n📝 All subdomains:`);
    Array.from(subdomainMap.entries()).forEach(([subdomain, restaurant]) => {
      console.log(`  ${subdomain} -> ${restaurant.name} (${restaurant.id})`);
    });
    
  } catch (error) {
    console.error('❌ Check failed:', error);
  }
}

// Run check if this script is executed directly
if (require.main === module) {
  checkSubdomainUniqueness()
    .then(() => {
      console.log('Check completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Check failed:', error);
      process.exit(1);
    });
}

module.exports = { checkSubdomainUniqueness };

// Check subdomain uniqueness
async function checkSubdomainUniqueness() {
  try {
    console.log('🔍 Checking subdomain uniqueness...');
    
    // Get all restaurants
    const snapshot = await db.collection(collections.restaurants).get();
    
    if (snapshot.empty) {
      console.log('✅ No restaurants found');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} restaurants`);
    
    const subdomainMap = new Map();
    const duplicates = [];
    
    snapshot.docs.forEach(doc => {
      const restaurantData = doc.data();
      const subdomain = restaurantData.subdomain;
      
      if (subdomain) {
        if (subdomainMap.has(subdomain)) {
          duplicates.push({
            subdomain,
            restaurant1: subdomainMap.get(subdomain),
            restaurant2: {
              id: doc.id,
              name: restaurantData.name
            }
          });
        } else {
          subdomainMap.set(subdomain, {
            id: doc.id,
            name: restaurantData.name
          });
        }
      }
    });
    
    console.log(`\n📋 Subdomain Summary:`);
    console.log(`  Total subdomains: ${subdomainMap.size}`);
    console.log(`  Duplicates found: ${duplicates.length}`);
    
    if (duplicates.length > 0) {
      console.log(`\n❌ Duplicate subdomains found:`);
      duplicates.forEach(dup => {
        console.log(`  Subdomain: ${dup.subdomain}`);
        console.log(`    Restaurant 1: ${dup.restaurant1.name} (${dup.restaurant1.id})`);
        console.log(`    Restaurant 2: ${dup.restaurant2.name} (${dup.restaurant2.id})`);
      });
    } else {
      console.log(`\n✅ All subdomains are unique!`);
    }
    
    // Show all subdomains
    console.log(`\n📝 All subdomains:`);
    Array.from(subdomainMap.entries()).forEach(([subdomain, restaurant]) => {
      console.log(`  ${subdomain} -> ${restaurant.name} (${restaurant.id})`);
    });
    
  } catch (error) {
    console.error('❌ Check failed:', error);
  }
}

// Run check if this script is executed directly
if (require.main === module) {
  checkSubdomainUniqueness()
    .then(() => {
      console.log('Check completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Check failed:', error);
      process.exit(1);
    });
}

module.exports = { checkSubdomainUniqueness };
