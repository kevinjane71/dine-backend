const admin = require('firebase-admin');
require('dotenv').config();

let db;

try {
  if (!admin.apps.length) {
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
    });

    console.log('✅ Firebase Admin initialized successfully');
  }

  db = admin.firestore();
  
  const collections = {
    users: 'users',
    restaurants: 'restaurants',
    menus: 'menus',
    orders: 'orders',
    payments: 'payments',
    inventory: 'inventory',
    analytics: 'analytics',
    feedback: 'feedback',
    loyalty: 'loyalty',
    tables: 'tables'
  };

  module.exports = {
    admin,
    db,
    collections
  };

} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  console.error('Please check your Firebase environment variables');
  
  module.exports = {
    admin: null,
    db: null,
    collections: {}
  };
}