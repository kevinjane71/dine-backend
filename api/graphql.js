const { ApolloServer } = require('@apollo/server');
const { typeDefs } = require('../graphql/schema');
const { resolvers } = require('../graphql/resolvers');

// Authentication middleware
const authenticateUser = async (req) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('No authorization token provided');
    }

    const token = authHeader.substring(7);
    
    // Verify token (using your existing token verification logic) oo
    const admin = require('firebase-admin');
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    return {
      userId: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name || decodedToken.email
    };
  } catch (error) {
    console.error('Authentication error:', error);
    throw new Error('Invalid or expired token');
  }
};

// Create Apollo Server
const server = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: true,
  playground: true
});

// Initialize server
let serverStarted = false;

const handler = async (req, res) => {
  if (!serverStarted) {
    await server.start();
    serverStarted = true;
  }

  try {
    // Create context
    const context = async () => {
      try {
        const user = await authenticateUser(req);
        return {
          user,
          db: require('../firebase').db
        };
      } catch (error) {
        return {
          user: null,
          db: require('../firebase').db
        };
      }
    };

    // Handle GraphQL requests
    const contextValue = await context();
    const result = await server.executeOperation({
      query: req.body.query,
      variables: req.body.variables,
      operationName: req.body.operationName,
      contextValue: contextValue
    });

    res.status(200).json(result.body);
    
  } catch (error) {
    console.error('GraphQL handler error:', error);
    res.status(500).json({
      errors: [{
        message: 'Internal server error',
        extensions: {
          code: 'INTERNAL_SERVER_ERROR'
        }
      }]
    });
  }
};

module.exports = handler;
