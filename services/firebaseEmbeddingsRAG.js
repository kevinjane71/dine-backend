const admin = require('firebase-admin');
const OpenAI = require('openai');

class FirebaseEmbeddingsRAGService {
  constructor() {
    this.db = admin.firestore();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  // Store restaurant knowledge with embeddings
  async storeRestaurantKnowledge(restaurantId) {
    try {
      console.log(`🔄 Storing knowledge for restaurant ${restaurantId}...`);
      
      // 1. Get restaurant data
      const restaurantData = await this.getRestaurantData(restaurantId);
      
      // 2. Create knowledge chunks
      const knowledgeChunks = await this.createKnowledgeChunks(restaurantData, restaurantId);
      
      // 3. Generate embeddings for each chunk
      const chunksWithEmbeddings = await this.generateEmbeddingsForChunks(knowledgeChunks);
      
      // 4. Store in Firebase
      await this.storeChunksInFirebase(restaurantId, chunksWithEmbeddings);
      
      console.log(`✅ Stored ${chunksWithEmbeddings.length} knowledge chunks for restaurant ${restaurantId}`);
      
    } catch (error) {
      console.error('Firebase embeddings storage error:', error);
    }
  }

  // Create knowledge chunks from restaurant data
  async createKnowledgeChunks(restaurantData, restaurantId) {
    const chunks = [];

    // Schema chunks
    if (restaurantData.schema) {
      Object.keys(restaurantData.schema.fields).forEach(field => {
        chunks.push({
          id: `${restaurantId}_schema_${field}`,
          type: 'schema',
          text: `Field: ${field}, Type: ${restaurantData.schema.fields[field]}, Description: ${restaurantData.schema.descriptions[field] || 'No description available'}`,
          fields: [field],
          apiEndpoint: null,
          restaurantId
        });
      });
    }

    // Menu chunks
    if (restaurantData.menu && restaurantData.menu.length > 0) {
      restaurantData.menu.forEach(item => {
        chunks.push({
          id: `${restaurantId}_menu_${item.id}`,
          type: 'menu',
          text: `Menu Item: ${item.name}, Price: ₹${item.price}, Category: ${item.category}, Description: ${item.description || 'No description'}, Vegetarian: ${item.isVeg ? 'Yes' : 'No'}`,
          fields: ['name', 'price', 'category', 'isVeg'],
          apiEndpoint: '/api/menu',
          restaurantId
        });
      });
    }

    // Table chunks
    if (restaurantData.tables && restaurantData.tables.length > 0) {
      restaurantData.tables.forEach(table => {
        chunks.push({
          id: `${restaurantId}_table_${table.id}`,
          type: 'table',
          text: `Table: ${table.tableNumber}, Status: ${table.status}, Capacity: ${table.capacity} people, Location: ${table.location || 'Main area'}`,
          fields: ['tableNumber', 'status', 'capacity'],
          apiEndpoint: '/api/tables',
          restaurantId
        });
      });
    }

    // API documentation chunks
    const apiDocs = this.getAPIDocumentation();
    apiDocs.forEach(api => {
      chunks.push({
        id: `${restaurantId}_api_${api.endpoint.replace(/\//g, '_')}`,
        type: 'api',
        text: `API: ${api.method} ${api.endpoint}, Description: ${api.description}, Parameters: ${JSON.stringify(api.parameters)}`,
        fields: api.relatedFields || [],
        apiEndpoint: api.endpoint,
        restaurantId
      });
    });

    // Intent examples chunks
    const intentExamples = this.getIntentExamples();
    intentExamples.forEach(intent => {
      chunks.push({
        id: `${restaurantId}_intent_${intent.name}`,
        type: 'intent',
        text: `Intent: ${intent.name}, Examples: ${intent.examples.join(', ')}, Required fields: ${intent.requiredFields.join(', ')}`,
        fields: intent.requiredFields,
        apiEndpoint: intent.apiEndpoint,
        restaurantId
      });
    });

    return chunks;
  }

  // Generate embeddings for chunks
  async generateEmbeddingsForChunks(chunks) {
    try {
      console.log(`🔄 Generating embeddings for ${chunks.length} chunks...`);
      
      // Process in batches to avoid rate limits
      const batchSize = 10;
      const batches = [];
      
      for (let i = 0; i < chunks.length; i += batchSize) {
        batches.push(chunks.slice(i, i + batchSize));
      }

      const chunksWithEmbeddings = [];

      for (const batch of batches) {
        const texts = batch.map(chunk => chunk.text);
        
        const response = await this.openai.embeddings.create({
          model: "text-embedding-ada-002",
          input: texts
        });

        batch.forEach((chunk, index) => {
          chunksWithEmbeddings.push({
            ...chunk,
            embedding: response.data[index].embedding
          });
        });

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`✅ Generated embeddings for ${chunksWithEmbeddings.length} chunks`);
      return chunksWithEmbeddings;
      
    } catch (error) {
      console.error('Embeddings generation error:', error);
      return chunks; // Return without embeddings as fallback
    }
  }

  // Store chunks in Firebase
  async storeChunksInFirebase(restaurantId, chunks) {
    try {
      const batch = this.db.batch();
      
      chunks.forEach(chunk => {
        const docRef = this.db.collection('rag_knowledge').doc(chunk.id);
        batch.set(docRef, {
          type: chunk.type,
          text: chunk.text,
          fields: chunk.fields,
          apiEndpoint: chunk.apiEndpoint,
          restaurantId: chunk.restaurantId,
          embedding: chunk.embedding || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      await batch.commit();
      console.log(`✅ Stored ${chunks.length} chunks in Firebase`);
      
    } catch (error) {
      console.error('Firebase storage error:', error);
    }
  }

  // Search RAG database using cosine similarity - SECURE VERSION
  async searchRAGDatabase(query, restaurantId, userId) {
    try {
      // SECURITY CHECK: Validate user has access to restaurant
      const { validateRestaurantAccess } = require('../middleware/ragSecurity');
      await validateRestaurantAccess(userId, restaurantId);

      // Generate query embedding
      const queryEmbedding = await this.generateQueryEmbedding(query);
      
      // SECURE QUERY: Double-check restaurantId in query
      const chunksSnapshot = await this.db.collection('rag_knowledge')
        .where('restaurantId', '==', restaurantId)
        .get();

      if (chunksSnapshot.empty) {
        console.log(`No knowledge chunks found for restaurant ${restaurantId}`);
        return [];
      }

      // Calculate cosine similarity
      const results = [];
      
      chunksSnapshot.docs.forEach(doc => {
        const chunk = doc.data();
        
        // SECURITY CHECK: Verify chunk belongs to correct restaurant
        if (chunk.restaurantId !== restaurantId) {
          console.error(`🚨 SECURITY ALERT: Chunk ${doc.id} has mismatched restaurantId`);
          return; // Skip this chunk
        }
        
        if (chunk.embedding) {
          const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
          
          if (similarity > 0.7) { // Threshold for relevance
            results.push({
              id: doc.id,
              text: chunk.text,
              type: chunk.type,
              fields: chunk.fields,
              apiEndpoint: chunk.apiEndpoint,
              score: similarity,
              restaurantId: chunk.restaurantId // Include for verification
            });
          }
        }
      });

      // Sort by similarity score
      results.sort((a, b) => b.score - a.score);
      
      // SECURITY LOG: Log RAG access
      console.log(`🔍 RAG Search: User ${userId} searched restaurant ${restaurantId}, found ${results.length} results`);
      
      return results.slice(0, 5);
      
    } catch (error) {
      console.error('RAG search error:', error);
      return [];
    }
  }

  // Generate embedding for query
  async generateQueryEmbedding(query) {
    try {
      const response = await this.openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: query
      });

      return response.data[0].embedding;
      
    } catch (error) {
      console.error('Query embedding error:', error);
      return [];
    }
  }

  // Calculate cosine similarity
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Get restaurant data
  async getRestaurantData(restaurantId) {
    try {
      const restaurantDoc = await this.db.collection('restaurants').doc(restaurantId).get();
      const menuSnapshot = await this.db.collection('restaurants').doc(restaurantId).collection('menu').get();
      const tablesSnapshot = await this.db.collection('restaurants').doc(restaurantId).collection('tables').get();

      return {
        restaurant: restaurantDoc.exists ? restaurantDoc.data() : null,
        menu: menuSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
        tables: tablesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
        schema: this.getRestaurantSchema(restaurantId)
      };
      
    } catch (error) {
      console.error('Restaurant data fetch error:', error);
      return { restaurant: null, menu: [], tables: [], schema: {} };
    }
  }

  // Get restaurant schema
  getRestaurantSchema(restaurantId) {
    return {
      fields: {
        'name': 'string',
        'price': 'number',
        'category': 'string',
        'isVeg': 'boolean',
        'description': 'string',
        'tableNumber': 'string',
        'status': 'string',
        'capacity': 'number',
        'location': 'string',
        'spiceLevel': 'string',
        'allergens': 'array',
        'isAvailable': 'boolean',
        'stock': 'number',
        'rating': 'number',
        'reviewCount': 'number'
      },
      descriptions: {
        'name': 'Name of the menu item or table',
        'price': 'Price in rupees',
        'category': 'Category like appetizer, main course, dessert, etc.',
        'isVeg': 'Whether the item is vegetarian',
        'description': 'Description of the item',
        'tableNumber': 'Table number identifier',
        'status': 'Table status like available, occupied, reserved, cleaning',
        'capacity': 'Number of people the table can seat',
        'location': 'Location of the table in the restaurant',
        'spiceLevel': 'Spice level like mild, medium, hot',
        'allergens': 'List of allergens in the dish',
        'isAvailable': 'Whether the item is currently available',
        'stock': 'Current stock quantity',
        'rating': 'Average rating of the item',
        'reviewCount': 'Number of reviews for the item'
      }
    };
  }

  // Get API documentation
  getAPIDocumentation() {
    return [
      {
        method: 'GET',
        endpoint: '/api/menu',
        description: 'Get all menu items for the restaurant',
        parameters: {},
        relatedFields: ['name', 'price', 'category', 'isVeg']
      },
      {
        method: 'POST',
        endpoint: '/api/orders',
        description: 'Create a new order',
        parameters: { tableNumber: 'string', items: 'array', customerName: 'string' },
        relatedFields: ['tableNumber', 'name', 'price']
      },
      {
        method: 'PUT',
        endpoint: '/api/tables/:tableId/status',
        description: 'Update table status',
        parameters: { status: 'string' },
        relatedFields: ['tableNumber', 'status']
      },
      {
        method: 'GET',
        endpoint: '/api/tables',
        description: 'Get all tables for the restaurant',
        parameters: {},
        relatedFields: ['tableNumber', 'status', 'capacity']
      },
      {
        method: 'POST',
        endpoint: '/api/tables/book',
        description: 'Book a table',
        parameters: { tableNumber: 'number', partySize: 'number', customerName: 'string' },
        relatedFields: ['tableNumber', 'capacity', 'status']
      },
      {
        method: 'GET',
        endpoint: '/api/orders',
        description: 'Get all orders for the restaurant',
        parameters: {},
        relatedFields: ['tableNumber', 'name', 'price']
      }
    ];
  }

  // Get intent examples
  getIntentExamples() {
    return [
      {
        name: 'menu_query',
        examples: ['show menu', 'what dishes do you have', 'vegetarian options', 'show me the food menu', 'what can I order'],
        requiredFields: ['name', 'price', 'category', 'isVeg'],
        apiEndpoint: '/api/menu'
      },
      {
        name: 'table_booking',
        examples: ['book table', 'reserve table', 'table for 4 people', 'book table number 5', 'reserve a table'],
        requiredFields: ['tableNumber', 'status', 'capacity'],
        apiEndpoint: '/api/tables/book'
      },
      {
        name: 'order_placement',
        examples: ['place order', 'order food', 'add to cart', 'order biryani', 'place order for table 3'],
        requiredFields: ['name', 'price', 'tableNumber'],
        apiEndpoint: '/api/orders'
      },
      {
        name: 'table_management',
        examples: ['show tables', 'table status', 'available tables', 'occupied tables', 'clean table 4'],
        requiredFields: ['tableNumber', 'status', 'capacity'],
        apiEndpoint: '/api/tables'
      },
      {
        name: 'restaurant_info',
        examples: ['opening hours', 'restaurant info', 'contact details', 'address', 'phone number'],
        requiredFields: ['name', 'address', 'phone', 'email'],
        apiEndpoint: null
      }
    ];
  }

  // Check if RAG knowledge exists for restaurant
  async hasRAGKnowledge(restaurantId) {
    try {
      const snapshot = await this.db.collection('rag_knowledge')
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();
      
      return !snapshot.empty;
    } catch (error) {
      console.error('RAG knowledge check error:', error);
      return false;
    }
  }

  // Clear RAG knowledge for restaurant
  async clearRAGKnowledge(restaurantId) {
    try {
      const snapshot = await this.db.collection('rag_knowledge')
        .where('restaurantId', '==', restaurantId)
        .get();

      const batch = this.db.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`✅ Cleared RAG knowledge for restaurant ${restaurantId}`);
      
    } catch (error) {
      console.error('Clear RAG knowledge error:', error);
    }
  }
}

module.exports = FirebaseEmbeddingsRAGService;
