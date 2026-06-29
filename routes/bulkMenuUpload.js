'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const chatgptUsageLimiter = require('../middleware/chatgptUsageLimiter');
const menuExtractionService = require('../services/menuExtractionService');
const { kvGet } = require('../utils/kvCache');
const realtimeService = require('../services/firebaseRealtimeService');

// Allowed file types for menu upload
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff',
  'text/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB

// ─── POST /api/menus/upload-url/:restaurantId ──────────────────────────────────
// Returns a GCS signed URL for direct upload from the browser + a jobId.
router.post('/upload-url/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { fileName, fileType, fileSize } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType are required' });
    }

    if (!ALLOWED_TYPES.has(fileType)) {
      return res.status(400).json({ error: `File type ${fileType} is not supported` });
    }

    if (fileSize && fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({ error: `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit` });
    }

    const bucket = req.app.get('bucket');
    if (!bucket) {
      return res.status(500).json({ error: 'Storage not configured' });
    }

    const timestamp = Date.now();
    const sanitizedName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const gcsPath = `menu-uploads/${restaurantId}/${timestamp}-${sanitizedName}`;
    const jobId = `menu-${restaurantId}-${timestamp}`;

    // Generate signed URL for PUT upload (15 min expiry)
    const [signedUrl] = await bucket.file(gcsPath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType: fileType,
    });

    res.json({
      success: true,
      jobId,
      uploadUrl: signedUrl,
      gcsPath,
    });
  } catch (error) {
    console.error('❌ Failed to generate upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// ─── POST /api/menus/process-upload/:restaurantId ──────────────────────────────
// Triggers async processing of an uploaded file. Returns 202 immediately.
router.post('/process-upload/:restaurantId', authenticateToken, chatgptUsageLimiter.middleware(), async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { jobId, gcsPath, fileName, fileType } = req.body;

    if (!jobId || !gcsPath) {
      return res.status(400).json({ error: 'jobId and gcsPath are required' });
    }

    const bucket = req.app.get('bucket');
    if (!bucket) {
      return res.status(500).json({ error: 'Storage not configured' });
    }

    // Verify file exists in GCS
    const [exists] = await bucket.file(gcsPath).exists();
    if (!exists) {
      return res.status(404).json({ error: 'File not found in storage. Please re-upload.' });
    }

    // Get business type from restaurant (if available)
    let businessType = 'restaurant';
    try {
      const { db } = require('../firebase');
      const restDoc = await db.collection('restaurants').doc(restaurantId).get();
      if (restDoc.exists) {
        businessType = restDoc.data()?.businessType || 'restaurant';
      }
    } catch (e) {
      // Default to restaurant
    }

    // Return 202 immediately — processing runs async
    res.status(202).json({
      success: true,
      jobId,
      status: 'processing',
      message: 'File is being processed. Listen to RTDB for progress updates.',
    });

    // Fire-and-forget: start extraction
    menuExtractionService.processUploadedFile(bucket, gcsPath, jobId, restaurantId, businessType)
      .then(() => {
        console.log(`✅ Job ${jobId} completed successfully`);
      })
      .catch(async (err) => {
        console.error(`❌ Job ${jobId} failed:`, err);
        try {
          await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-failed', {
            jobId,
            error: err.message || 'Processing failed',
          });
        } catch (rtdbErr) {
          console.error('Failed to push failure event:', rtdbErr.message);
        }
      });
  } catch (error) {
    console.error('❌ Failed to start processing:', error);
    res.status(500).json({ error: 'Failed to start processing' });
  }
});

// ─── GET /api/menus/upload-status/:restaurantId/:jobId ─────────────────────────
// Fallback polling endpoint (in case RTDB listener has issues).
router.get('/upload-status/:restaurantId/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    // Check if result exists in Redis (means job is complete)
    const cached = await kvGet(`bulk-upload:${jobId}`);
    if (cached) {
      return res.json({ status: 'complete', jobId });
    }

    // Otherwise, job is still processing or failed/expired
    res.json({ status: 'processing', jobId });
  } catch (error) {
    console.error('❌ Failed to get upload status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// ─── GET /api/menus/upload-result/:restaurantId/:jobId ─────────────────────────
// Fetch extraction results from Redis.
router.get('/upload-result/:restaurantId/:jobId', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    const cached = await kvGet(`bulk-upload:${jobId}`);
    if (!cached) {
      return res.status(404).json({
        error: 'Results not found or expired. Please re-upload the file.',
      });
    }

    const result = JSON.parse(cached);
    res.json({
      success: true,
      ...result,
      extractedCategories: result.categories || [],
    });
  } catch (error) {
    console.error('❌ Failed to get upload result:', error);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

module.exports = router;
