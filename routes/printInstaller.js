/**
 * Print Installer (KOT Printer) upload and download URLs.
 * Uses the same Firebase Storage bucket as menu uploads (bucket passed from index.js).
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { db } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');

const COLLECTION = 'print_installer_releases';
const DOC_ID = 'current';
const RELEASES_PREFIX = 'releases/';
const WINDOWS_FILENAME = 'kot-printer-setup.exe';
const MAC_FILENAME = 'kot-printer.dmg';
const MAX_FILE_SIZE = 350 * 1024 * 1024; // 350MB

const uploadInstaller = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const isExe = name.endsWith('.exe') || file.mimetype === 'application/x-msdownload' || file.mimetype === 'application/octet-stream';
    const isDmg = name.endsWith('.dmg') || file.mimetype === 'application/x-apple-diskimage';
    if (isExe || isDmg) {
      cb(null, true);
      return;
    }
    cb(new Error('Only .exe (Windows) or .dmg (Mac) files are allowed.'), false);
  }
});

/**
 * POST /api/print-installer/upload
 * Upload Windows (.exe) or Mac (.dmg) installer. Overwrites the current file for that platform.
 */
router.post('/upload', authenticateToken, requireOwnerRole, uploadInstaller.single('installer'), async (req, res) => {
  const bucket = req.app.get('printInstallerBucket');
  try {
    if (!bucket) {
      return res.status(503).json({ success: false, error: 'Storage not configured' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "installer".' });
    }
    const name = (file.originalname || '').toLowerCase();
    const isWindows = name.endsWith('.exe');
    const isMac = name.endsWith('.dmg');
    if (!isWindows && !isMac) {
      return res.status(400).json({ success: false, error: 'File must be .exe (Windows) or .dmg (Mac).' });
    }

    const filename = isWindows ? RELEASES_PREFIX + WINDOWS_FILENAME : RELEASES_PREFIX + MAC_FILENAME;
    const blob = bucket.file(filename);
    const contentType = isWindows ? 'application/x-msdownload' : 'application/x-apple-diskimage';

    await blob.save(file.buffer, {
      contentType,
      metadata: {
        cacheControl: 'public, max-age=3600',
        metadata: {
          uploadedBy: req.user.userId || req.user.uid,
          uploadedAt: new Date().toISOString(),
          platform: isWindows ? 'windows' : 'mac'
        }
      }
    });
    await blob.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;

    const docRef = db.collection(COLLECTION).doc(DOC_ID);
    const update = {
      updatedAt: new Date().toISOString()
    };
    if (isWindows) update.windowsUrl = publicUrl; else update.macUrl = publicUrl;
    await docRef.set(update, { merge: true });

    return res.json({
      success: true,
      platform: isWindows ? 'windows' : 'mac',
      url: publicUrl,
      message: isWindows ? 'Windows installer uploaded.' : 'Mac installer uploaded.'
    });
  } catch (error) {
    console.error('Print installer upload error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload installer'
    });
  }
});

/**
 * GET /api/print-installer/urls
 * Returns download URLs for Windows and Mac installers. Same global URLs for all authenticated users
 * (not per-account); any logged-in user can fetch and download.
 */
router.get('/urls', authenticateToken, async (req, res) => {
  try {
    const docRef = db.collection(COLLECTION).doc(DOC_ID);
    const doc = await docRef.get();
    const data = doc.exists ? doc.data() : {};
    return res.json({
      success: true,
      windowsUrl: data.windowsUrl || null,
      macUrl: data.macUrl || null,
      updatedAt: data.updatedAt || null
    });
  } catch (error) {
    console.error('Print installer urls error:', error);
    return res.status(500).json({ success: false, error: 'Failed to get installer URLs' });
  }
});

module.exports = router;
