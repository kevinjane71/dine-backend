/**
 * Firestore Query Optimizer
 * Optimizes Firestore queries for better performance on Vercel
 * 
 * Key optimizations:
 * 1. Parallel query execution
 * 2. Connection reuse
 * 3. Query result caching
 * 4. Batch operations
 */

const { getDb } = require('../firebase');

class FirestoreOptimizer {
  constructor() {
    // In-memory cache for frequently accessed data (TTL: 30 seconds)
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  /**
   * Execute multiple Firestore queries in parallel
   * @param {Array} queries - Array of query promises
   * @returns {Promise<Array>} Results array
   */
  async executeParallel(queries) {
    try {
      const startTime = Date.now();
      const results = await Promise.all(queries);
      const duration = Date.now() - startTime;
      
      if (duration > 1000) {
        console.warn(`⚠️ Parallel queries took ${duration}ms (${queries.length} queries)`);
      }
      
      return results;
    } catch (error) {
      console.error('Error executing parallel queries:', error);
      throw error;
    }
  }

  /**
   * Get document with caching
   * @param {string} collection - Collection name
   * @param {string} docId - Document ID
   * @param {boolean} useCache - Whether to use cache (default: true)
   * @returns {Promise<Object>} Document data
   */
  async getDoc(collection, docId, useCache = true) {
    const cacheKey = `${collection}:${docId}`;
    
    // Check cache first
    if (useCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    // Fetch from Firestore
    const db = getDb();
    const startTime = Date.now();
    const doc = await db.collection(collection).doc(docId).get();
    const duration = Date.now() - startTime;
    
    if (duration > 500) {
      console.warn(`⚠️ Firestore getDoc took ${duration}ms: ${collection}/${docId}`);
    }

    if (!doc.exists) {
      return null;
    }

    const data = { id: doc.id, ...doc.data() };
    
    // Cache the result
    if (useCache) {
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });
    }

    return data;
  }

  /**
   * Get multiple documents in parallel
   * @param {string} collection - Collection name
   * @param {Array<string>} docIds - Array of document IDs
   * @returns {Promise<Array>} Array of document data
   */
  async getDocs(collection, docIds) {
    const queries = docIds.map(id => 
      this.getDoc(collection, id, true)
    );
    return this.executeParallel(queries);
  }

  /**
   * Query collection with optimization
   * @param {string} collection - Collection name
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options (limit, orderBy, etc.)
   * @returns {Promise<Array>} Array of documents
   */
  async queryCollection(collection, filters = {}, options = {}) {
    const db = getDb();
    const startTime = Date.now();
    let query = db.collection(collection);

    // Apply filters
    Object.entries(filters).forEach(([field, value]) => {
      if (value !== undefined && value !== null) {
        query = query.where(field, '==', value);
      }
    });

    // Apply orderBy
    if (options.orderBy) {
      query = query.orderBy(options.orderBy.field, options.orderBy.direction || 'asc');
    }

    // Apply limit
    if (options.limit) {
      query = query.limit(options.limit);
    }

    const snapshot = await query.get();
    const duration = Date.now() - startTime;
    
    if (duration > 500) {
      console.warn(`⚠️ Firestore query took ${duration}ms: ${collection}`, filters);
    }

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  }

  /**
   * Batch write operations
   * @param {Array} operations - Array of {type, collection, docId, data}
   * @returns {Promise<void>}
   */
  async batchWrite(operations) {
    const db = getDb();
    const batch = db.batch();
    const startTime = Date.now();

    operations.forEach(op => {
      const ref = db.collection(op.collection).doc(op.docId);
      
      switch (op.type) {
        case 'set':
          batch.set(ref, op.data);
          break;
        case 'update':
          batch.update(ref, op.data);
          break;
        case 'delete':
          batch.delete(ref);
          break;
      }
    });

    await batch.commit();
    const duration = Date.now() - startTime;
    
    if (duration > 500) {
      console.warn(`⚠️ Batch write took ${duration}ms: ${operations.length} operations`);
    }

    // Clear cache for affected documents
    operations.forEach(op => {
      const cacheKey = `${op.collection}:${op.docId}`;
      this.cache.delete(cacheKey);
    });
  }

  /**
   * Clear cache for a specific document or collection
   * @param {string} collection - Collection name
   * @param {string} docId - Document ID (optional)
   */
  clearCache(collection, docId = null) {
    if (docId) {
      const cacheKey = `${collection}:${docId}`;
      this.cache.delete(cacheKey);
    } else {
      // Clear all cache entries for this collection
      const prefix = `${collection}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Warm up Firestore connection
   * Performs a lightweight query to establish connection
   */
  async warmUp() {
    try {
      const db = getDb();
      const startTime = Date.now();
      // Perform a lightweight query to establish connection
      await db.collection('_warmup').limit(1).get();
      const duration = Date.now() - startTime;
      console.log(`🔥 Firestore connection warmed up in ${duration}ms`);
    } catch (error) {
      // Ignore errors - collection might not exist, that's fine
      console.log('🔥 Firestore warm-up completed (connection established)');
    }
  }
}

// Singleton instance
const optimizer = new FirestoreOptimizer();

// Warm up connection on module load (for Vercel serverless)
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
  // Warm up in background, don't block
  setImmediate(() => {
    optimizer.warmUp().catch(err => {
      console.log('Warm-up completed (connection ready)');
    });
  });
}

module.exports = optimizer;

