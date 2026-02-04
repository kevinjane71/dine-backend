// One-time script to fix restaurant name spelling
// Run with: node scripts/fix-restaurant-name.js

const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function fixRestaurantName() {
  try {
    // Find restaurants with "prestine" in the name
    const restaurantsSnapshot = await db.collection('restaurants').get();

    let updated = 0;
    for (const doc of restaurantsSnapshot.docs) {
      const data = doc.data();
      if (data.name && data.name.toLowerCase().includes('prestine')) {
        const newName = data.name.replace(/prestine/gi, 'pristine');
        console.log(`Updating restaurant ${doc.id}:`);
        console.log(`  Old name: ${data.name}`);
        console.log(`  New name: ${newName}`);

        await db.collection('restaurants').doc(doc.id).update({
          name: newName,
          updatedAt: new Date()
        });
        updated++;
      }
    }

    if (updated === 0) {
      console.log('No restaurants found with "prestine" in the name.');
    } else {
      console.log(`\nUpdated ${updated} restaurant(s) successfully.`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error fixing restaurant name:', error);
    process.exit(1);
  }
}

fixRestaurantName();
