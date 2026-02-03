/**
 * DineAI Knowledge Service
 * Pinecone RAG integration for document search and retrieval
 */

const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const { getDb } = require('../../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const PINECONE_INDEX = process.env.PINECONE_INDEX || 'dineopen';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;
const MAX_CHUNK_TOKENS = 500;
const CHUNK_OVERLAP = 50;

class DineAIKnowledgeService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.pinecone = null;
    this.index = null;
    this.initialized = false;
  }

  /**
   * Initialize Pinecone connection
   */
  async initialize() {
    if (this.initialized) return;

    try {
      if (!process.env.PINECONE_API_KEY) {
        console.warn('PINECONE_API_KEY not set - knowledge base features disabled');
        return;
      }

      this.pinecone = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY
      });

      // Get or create index
      const indexes = await this.pinecone.listIndexes();
      const indexExists = indexes.indexes?.some(idx => idx.name === PINECONE_INDEX);

      if (!indexExists) {
        console.log(`Creating Pinecone index: ${PINECONE_INDEX}`);
        await this.pinecone.createIndex({
          name: PINECONE_INDEX,
          dimension: EMBEDDING_DIMENSION,
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: process.env.PINECONE_ENVIRONMENT || 'us-east-1'
            }
          }
        });

        // Wait for index to be ready
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      this.index = this.pinecone.index(PINECONE_INDEX);
      this.initialized = true;
      console.log('✅ DineAI Knowledge Service initialized');
    } catch (error) {
      console.error('Error initializing Pinecone:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for text
   */
  async generateEmbedding(text) {
    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text
    });

    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts) {
    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts
    });

    return response.data.map(d => d.embedding);
  }

  /**
   * Chunk text into smaller pieces
   */
  chunkText(text, maxTokens = MAX_CHUNK_TOKENS, overlap = CHUNK_OVERLAP) {
    // Simple word-based chunking (approximate tokens)
    const words = text.split(/\s+/);
    const chunks = [];
    const wordsPerChunk = Math.floor(maxTokens * 0.75); // Approximate words per token

    let startIndex = 0;

    while (startIndex < words.length) {
      const endIndex = Math.min(startIndex + wordsPerChunk, words.length);
      const chunk = words.slice(startIndex, endIndex).join(' ');

      chunks.push({
        text: chunk,
        startIndex,
        endIndex
      });

      // Move forward with overlap
      startIndex = endIndex - Math.floor(overlap * 0.75);

      // Prevent infinite loop
      if (startIndex >= words.length - 1) break;
    }

    return chunks;
  }

  /**
   * Store document in knowledge base
   */
  async storeDocument(restaurantId, document) {
    await this.initialize();

    if (!this.index) {
      throw new Error('Knowledge base not available');
    }

    const {
      id,
      title,
      content,
      type,
      category,
      source,
      tags = []
    } = document;

    // Chunk the content
    const chunks = this.chunkText(content);

    // Generate embeddings for all chunks
    const embeddings = await this.generateEmbeddings(chunks.map(c => c.text));

    // Prepare vectors for Pinecone
    const vectors = chunks.map((chunk, i) => ({
      id: `${restaurantId}_${type}_${id}_chunk${i}`,
      values: embeddings[i],
      metadata: {
        restaurantId,
        documentId: id,
        documentType: type,
        category: category || 'general',
        text: chunk.text,
        title: title || '',
        source: source || '',
        chunkIndex: i,
        totalChunks: chunks.length,
        createdAt: Date.now(),
        tags: tags
      }
    }));

    // Upsert to Pinecone
    await this.index.upsert(vectors);

    // Store document metadata in Firestore
    const db = getDb();
    await db.collection('dineai_knowledge').doc(`${restaurantId}_${id}`).set({
      restaurantId,
      documentId: id,
      title,
      type,
      category,
      source,
      tags,
      chunkCount: chunks.length,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      documentId: id,
      chunksStored: chunks.length
    };
  }

  /**
   * Search knowledge base
   */
  async search(restaurantId, query, options = {}) {
    await this.initialize();

    if (!this.index) {
      return { success: true, results: [], message: 'Knowledge base not available' };
    }

    const {
      category = null,
      limit = 5,
      minScore = 0.7
    } = options;

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Build filter
    const filter = {
      restaurantId: { $eq: restaurantId }
    };

    if (category) {
      filter.category = { $eq: category };
    }

    // Query Pinecone
    const results = await this.index.query({
      vector: queryEmbedding,
      topK: limit,
      filter,
      includeMetadata: true
    });

    // Filter by score and format results
    const formattedResults = results.matches
      .filter(match => match.score >= minScore)
      .map(match => ({
        id: match.id,
        score: match.score,
        text: match.metadata.text,
        title: match.metadata.title,
        source: match.metadata.source,
        category: match.metadata.category,
        documentType: match.metadata.documentType
      }));

    return {
      success: true,
      results: formattedResults,
      count: formattedResults.length
    };
  }

  /**
   * Add FAQ entry
   */
  async addFAQ(restaurantId, faq) {
    const { question, answer, category = 'faq', tags = [] } = faq;

    const faqId = `faq_${Date.now()}`;
    const content = `Question: ${question}\nAnswer: ${answer}`;

    return await this.storeDocument(restaurantId, {
      id: faqId,
      title: question,
      content,
      type: 'faq',
      category,
      source: 'manual',
      tags
    });
  }

  /**
   * Delete document from knowledge base
   */
  async deleteDocument(restaurantId, documentId) {
    await this.initialize();

    if (!this.index) {
      throw new Error('Knowledge base not available');
    }

    // Get document metadata from Firestore
    const db = getDb();
    const docRef = db.collection('dineai_knowledge').doc(`${restaurantId}_${documentId}`);
    const doc = await docRef.get();

    if (!doc.exists) {
      return { success: false, error: 'Document not found' };
    }

    const docData = doc.data();
    const chunkCount = docData.chunkCount || 1;

    // Delete all chunks from Pinecone
    const idsToDelete = [];
    for (let i = 0; i < chunkCount; i++) {
      idsToDelete.push(`${restaurantId}_${docData.type}_${documentId}_chunk${i}`);
    }

    await this.index.deleteMany(idsToDelete);

    // Delete from Firestore
    await docRef.delete();

    return {
      success: true,
      message: `Deleted document and ${chunkCount} chunks`
    };
  }

  /**
   * Get all knowledge items for restaurant
   */
  async getKnowledgeItems(restaurantId, options = {}) {
    const db = getDb();
    const { type = null, category = null, limit = 50 } = options;

    let query = db.collection('dineai_knowledge')
      .where('restaurantId', '==', restaurantId);

    if (type) {
      query = query.where('type', '==', type);
    }

    if (category) {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.limit(limit).get();

    const items = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      items.push({
        id: data.documentId,
        title: data.title,
        type: data.type,
        category: data.category,
        source: data.source,
        tags: data.tags,
        chunkCount: data.chunkCount,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
      });
    });

    return {
      success: true,
      items,
      count: items.length
    };
  }

  /**
   * Re-index all knowledge for a restaurant
   */
  async reindexAll(restaurantId) {
    await this.initialize();

    if (!this.index) {
      throw new Error('Knowledge base not available');
    }

    // Get all documents from Firestore
    const db = getDb();
    const snapshot = await db.collection('dineai_knowledge')
      .where('restaurantId', '==', restaurantId)
      .get();

    let reindexed = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Get full document content if stored
      // For FAQs and simple documents, the metadata should have enough info
      // For uploaded files, we'd need to re-read from storage

      // Skip re-indexing for now - just count
      reindexed++;
    }

    return {
      success: true,
      message: `Found ${reindexed} documents for re-indexing`,
      count: reindexed
    };
  }

  /**
   * Get context for a query (used by voice service)
   */
  async getContext(restaurantId, query) {
    const searchResult = await this.search(restaurantId, query, {
      limit: 3,
      minScore: 0.65
    });

    if (!searchResult.success || searchResult.results.length === 0) {
      return null;
    }

    // Combine relevant chunks into context
    const context = searchResult.results
      .map(r => r.text)
      .join('\n\n');

    return {
      context,
      sources: searchResult.results.map(r => ({
        title: r.title,
        source: r.source
      }))
    };
  }

  /**
   * Get statistics for restaurant's knowledge base
   */
  async getStatistics(restaurantId) {
    const items = await this.getKnowledgeItems(restaurantId);

    const stats = {
      totalDocuments: items.count,
      byType: {},
      byCategory: {},
      totalChunks: 0
    };

    for (const item of items.items) {
      stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
      stats.byCategory[item.category] = (stats.byCategory[item.category] || 0) + 1;
      stats.totalChunks += item.chunkCount || 0;
    }

    return {
      success: true,
      statistics: stats
    };
  }
}

module.exports = new DineAIKnowledgeService();
