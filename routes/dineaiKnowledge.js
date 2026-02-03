/**
 * DineAI Knowledge Routes
 * Knowledge base CRUD operations
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const knowledgeService = require('../services/dineai/DineAIKnowledgeService');
const documentProcessor = require('../services/dineai/DineAIDocumentProcessor');
const {
  authenticateDineAI,
  requireManagerRole
} = require('../middleware/dineaiAuth');
const { authenticateToken } = require('../middleware/auth');

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB max file size
    files: 10 // Max 10 files at once
  },
  fileFilter: (req, file, cb) => {
    if (documentProcessor.isSupported(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
  }
});

// ==================== Document Upload ====================

/**
 * Upload document(s) to knowledge base
 * POST /api/dineai/knowledge/upload
 */
router.post('/dineai/knowledge/upload',
  authenticateDineAI,
  requireManagerRole,
  upload.array('files', 10),
  async (req, res) => {
    try {
      const { restaurantId } = req;
      const { category, tags } = req.body;
      const files = req.files;

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No files uploaded'
        });
      }

      console.log(`📄 Processing ${files.length} files for knowledge base`);

      const results = [];
      const errors = [];

      for (const file of files) {
        try {
          // Process the document
          const prepared = await documentProcessor.prepareForKnowledgeBase(file, restaurantId);

          // Override category and tags if provided
          if (category) prepared.category = category;
          if (tags) {
            const tagArray = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;
            prepared.tags = [...new Set([...prepared.tags, ...tagArray])];
          }

          // Store in knowledge base
          const stored = await knowledgeService.storeDocument(restaurantId, prepared);

          results.push({
            filename: file.originalname,
            documentId: prepared.id,
            title: prepared.title,
            category: prepared.category,
            chunks: stored.chunksStored,
            success: true
          });
        } catch (error) {
          console.error(`Error processing ${file.originalname}:`, error);
          errors.push({
            filename: file.originalname,
            error: error.message
          });
        }
      }

      res.json({
        success: true,
        processed: results.length,
        failed: errors.length,
        results,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error('Error uploading documents:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to upload documents'
      });
    }
  }
);

// ==================== URL Processing ====================

/**
 * Process URL content and add to knowledge base
 * POST /api/dineai/knowledge/url
 */
router.post('/dineai/knowledge/url',
  authenticateDineAI,
  requireManagerRole,
  async (req, res) => {
    try {
      const { restaurantId } = req;
      const { url, title, category, tags } = req.body;

      if (!url) {
        return res.status(400).json({
          success: false,
          error: 'URL is required'
        });
      }

      console.log(`🌐 Processing URL: ${url}`);

      // Process URL content
      const content = await documentProcessor.processURL(url);

      if (!content || content.length < 50) {
        return res.status(400).json({
          success: false,
          error: 'Could not extract meaningful content from URL'
        });
      }

      // Detect category if not provided
      const detectedCategory = category || await documentProcessor.detectCategory(content);

      // Generate tags if not provided
      const generatedTags = tags || await documentProcessor.generateTags(content);

      // Store in knowledge base
      const documentId = `url_${Date.now()}`;
      const result = await knowledgeService.storeDocument(restaurantId, {
        id: documentId,
        title: title || url,
        content,
        type: 'url',
        category: detectedCategory,
        source: url,
        tags: generatedTags
      });

      res.json({
        success: true,
        documentId,
        title: title || url,
        category: detectedCategory,
        tags: generatedTags,
        chunks: result.chunksStored,
        characterCount: content.length
      });
    } catch (error) {
      console.error('Error processing URL:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to process URL'
      });
    }
  }
);

// ==================== FAQ Management ====================

/**
 * Add FAQ entry
 * POST /api/dineai/knowledge/faq
 */
router.post('/dineai/knowledge/faq',
  authenticateDineAI,
  requireManagerRole,
  async (req, res) => {
    try {
      const { restaurantId } = req;
      const { question, answer, category, tags } = req.body;

      if (!question || !answer) {
        return res.status(400).json({
          success: false,
          error: 'Question and answer are required'
        });
      }

      console.log(`❓ Adding FAQ: ${question.substring(0, 50)}...`);

      const result = await knowledgeService.addFAQ(restaurantId, {
        question,
        answer,
        category: category || 'faq',
        tags: tags || []
      });

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('Error adding FAQ:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to add FAQ'
      });
    }
  }
);

// ==================== Knowledge List & Delete ====================

/**
 * Get all knowledge items for restaurant
 * GET /api/dineai/knowledge/:restaurantId
 */
router.get('/dineai/knowledge/:restaurantId',
  authenticateToken,
  async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { type, category, limit } = req.query;

      const result = await knowledgeService.getKnowledgeItems(restaurantId, {
        type,
        category,
        limit: parseInt(limit) || 50
      });

      res.json(result);
    } catch (error) {
      console.error('Error getting knowledge items:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get knowledge items'
      });
    }
  }
);

/**
 * Delete knowledge item
 * DELETE /api/dineai/knowledge/:docId
 */
router.delete('/dineai/knowledge/:docId',
  authenticateDineAI,
  requireManagerRole,
  async (req, res) => {
    try {
      const { restaurantId } = req;
      const { docId } = req.params;

      console.log(`🗑️ Deleting knowledge item: ${docId}`);

      const result = await knowledgeService.deleteDocument(restaurantId, docId);

      res.json(result);
    } catch (error) {
      console.error('Error deleting knowledge item:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to delete knowledge item'
      });
    }
  }
);

// ==================== Search & Re-index ====================

/**
 * Search knowledge base
 * POST /api/dineai/knowledge/search
 */
router.post('/dineai/knowledge/search',
  authenticateDineAI,
  async (req, res) => {
    try {
      const { restaurantId } = req;
      const { query, category, limit, minScore } = req.body;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: 'Query is required'
        });
      }

      const result = await knowledgeService.search(restaurantId, query, {
        category,
        limit: limit || 5,
        minScore: minScore || 0.7
      });

      res.json(result);
    } catch (error) {
      console.error('Error searching knowledge base:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search knowledge base'
      });
    }
  }
);

/**
 * Re-index all knowledge
 * POST /api/dineai/knowledge/reindex
 */
router.post('/dineai/knowledge/reindex',
  authenticateDineAI,
  requireManagerRole,
  async (req, res) => {
    try {
      const { restaurantId } = req;

      console.log(`🔄 Re-indexing knowledge for restaurant ${restaurantId}`);

      const result = await knowledgeService.reindexAll(restaurantId);

      res.json(result);
    } catch (error) {
      console.error('Error re-indexing knowledge:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to re-index knowledge'
      });
    }
  }
);

// ==================== Statistics ====================

/**
 * Get knowledge base statistics
 * GET /api/dineai/knowledge/:restaurantId/stats
 */
router.get('/dineai/knowledge/:restaurantId/stats',
  authenticateToken,
  async (req, res) => {
    try {
      const { restaurantId } = req.params;

      const result = await knowledgeService.getStatistics(restaurantId);

      res.json(result);
    } catch (error) {
      console.error('Error getting knowledge stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get statistics'
      });
    }
  }
);

module.exports = router;
