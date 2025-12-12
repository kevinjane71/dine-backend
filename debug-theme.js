const { db, collections } = require('./firebase');

async function checkRestaurantTheme(restaurantId) {
  try {
    console.log(`Checking theme for restaurant: ${restaurantId}`);
    const doc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!doc.exists) {
      console.log('Restaurant not found');
      return;
    }
    const data = doc.data();
    console.log('Restaurant Data (menuTheme):', JSON.stringify(data.menuTheme, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

checkRestaurantTheme('ZumnhNz0i8YTKFERbvOy');
