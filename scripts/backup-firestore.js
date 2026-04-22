#!/usr/bin/env node
/**
 * Firestore Backup Script
 *
 * Exports all collections from the 'dine' named database to local JSON files.
 *
 * Usage:
 *   node scripts/backup-firestore.js              # Backup all collections
 *   node scripts/backup-firestore.js orders users  # Backup specific collections
 *   node scripts/backup-firestore.js --email       # Backup + email zip (needs config)
 *
 * Output: ./backups/backup-YYYY-MM-DD-HHmmss/ dd
 */

require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

// ── Initialize Firebase Admin ──────────────────────────────────────────
let app;
try {
  app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    })
  }, 'backup-script');
} catch (e) {
  // Already initialized
  const { getApp } = require('firebase-admin/app');
  try { app = getApp('backup-script'); } catch { app = getApp(); }
}

const db = getFirestore(app, 'dine');

// ── All collections ────────────────────────────────────────────────────
const ALL_COLLECTIONS = [
  'users', 'restaurants', 'menus', 'menuItems', 'orders', 'payments',
  'inventory', 'suppliers', 'recipes', 'purchaseOrders', 'analytics',
  'feedback', 'loyalty', 'tables', 'floors', 'bookings', 'staffUsers',
  'userRestaurants', 'restaurantSettings', 'discountSettings', 'customers',
  'purchase-requisitions', 'goods-receipt-notes', 'supplier-invoices',
  'supplier-returns', 'stock-transfers', 'po-templates', 'supplier-quotations',
  'supplier-performance', 'inventoryTransactions', 'stockBatches', 'aiUsage',
  'automations', 'automation-templates', 'automation-settings', 'automation-logs',
  'coupons', 'customer-segments', 'saved_carts', 'idempotency_keys',
  'inv_organizations', 'inv_customers', 'inv_items', 'inv_invoices',
  'inv_quotes', 'inv_challans', 'inv_payments', 'inv_expenses',
  'inv_settings', 'inv_number_sequences', 'expenses', 'payrollConfig',
  'payrollRuns', 'paySlips', 'chartOfAccounts', 'journalEntries',
  'wasteEntries', 'stockAudits', 'productionEntries', 'attendance',
  'customerAppSettings'
];

// ── Helpers ────────────────────────────────────────────────────────────
function serializeDoc(doc) {
  const data = doc.data();
  // Convert Firestore Timestamps to ISO strings
  const serialized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value.toDate === 'function') {
      serialized[key] = { _type: 'Timestamp', value: value.toDate().toISOString() };
    } else if (value && value._seconds !== undefined) {
      serialized[key] = { _type: 'Timestamp', value: new Date(value._seconds * 1000).toISOString() };
    } else {
      serialized[key] = value;
    }
  }
  return { _id: doc.id, ...serialized };
}

async function backupCollection(collectionName, backupDir) {
  try {
    const snapshot = await db.collection(collectionName).get();
    if (snapshot.empty) {
      return { name: collectionName, count: 0, skipped: true };
    }

    const docs = snapshot.docs.map(serializeDoc);
    const filePath = path.join(backupDir, `${collectionName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
    return { name: collectionName, count: docs.length, skipped: false };
  } catch (err) {
    return { name: collectionName, count: 0, error: err.message };
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const wantEmail = process.argv.includes('--email');

  // Determine which collections to back up
  const collections = args.length > 0 ? args : ALL_COLLECTIONS;

  // Create backup directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(__dirname, '..', 'backups', `backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log(`\n🔄 Firestore Backup Starting...`);
  console.log(`📁 Output: ${backupDir}`);
  console.log(`📋 Collections: ${collections.length}\n`);

  const results = [];
  let totalDocs = 0;

  for (const col of collections) {
    process.stdout.write(`  Backing up ${col}...`);
    const result = await backupCollection(col, backupDir);
    results.push(result);

    if (result.error) {
      console.log(` ❌ Error: ${result.error}`);
    } else if (result.skipped) {
      console.log(` ⏭  Empty`);
    } else {
      console.log(` ✅ ${result.count} docs`);
      totalDocs += result.count;
    }
  }

  // Write summary
  const summary = {
    timestamp: new Date().toISOString(),
    project: process.env.FIREBASE_PROJECT_ID,
    database: 'dine',
    totalCollections: results.filter(r => !r.skipped && !r.error).length,
    totalDocuments: totalDocs,
    collections: results
  };
  fs.writeFileSync(path.join(backupDir, '_summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Backup complete!`);
  console.log(`   📄 ${totalDocs} total documents`);
  console.log(`   📁 ${results.filter(r => !r.skipped && !r.error).length} collections backed up`);
  console.log(`   ⏭  ${results.filter(r => r.skipped).length} empty collections`);
  if (results.some(r => r.error)) {
    console.log(`   ❌ ${results.filter(r => r.error).length} errors`);
  }
  console.log(`   📂 ${backupDir}\n`);

  // Create zip for email
  if (wantEmail) {
    try {
      const { execSync } = require('child_process');
      const zipPath = `${backupDir}.zip`;
      execSync(`cd "${path.dirname(backupDir)}" && zip -r "${path.basename(backupDir)}.zip" "${path.basename(backupDir)}"`);
      const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      console.log(`📦 Zip created: ${zipPath} (${sizeMB} MB)`);

      if (parseFloat(sizeMB) > 25) {
        console.log(`⚠️  File too large for email (${sizeMB} MB > 25 MB limit)`);
        console.log(`   Upload to Google Drive or use: scp ${zipPath} user@server:/path/`);
      } else {
        console.log(`📧 To email this backup, run:`);
        console.log(`   # Using mail command (macOS):`);
        console.log(`   echo "Firestore backup ${timestamp}" | mail -s "DineOpen DB Backup ${timestamp}" -A "${zipPath}" your@email.com`);
        console.log(`\n   # Or using Gmail SMTP (install: npm i nodemailer):`);
        console.log(`   node scripts/email-backup.js "${zipPath}"`);
      }
    } catch (err) {
      console.log(`❌ Zip failed: ${err.message}`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Backup failed:', err);
  process.exit(1);
});
