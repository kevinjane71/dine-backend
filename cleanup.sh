#!/bin/bash

# Remove GraphQL endpoints from index.js
# This script removes all GraphQL-related code and keeps only the simple chatbot

# Create a backup
cp /Users/vkumar4/code-test/dine/dine-backend/index.js /Users/vkumar4/code-test/dine/dine-backend/index.js.backup

# Remove GraphQL endpoint
sed -i '' '/app.use.*graphql/d' /Users/vkumar4/code-test/dine/dine-backend/index.js

# Remove all dinebot endpoints except the simple query one
sed -i '' '/app.post.*dinebot\/graphql/,/^});$/d' /Users/vkumar4/code-test/dine/dine-backend/index.js
sed -i '' '/app.post.*dinebot\/function-calling/,/^});$/d' /Users/vkumar4/code-test/dine/dine-backend/index.js
sed -i '' '/app.post.*dinebot\/optimized/,/^});$/d' /Users/vkumar4/code-test/dine/dine-backend/index.js
sed -i '' '/app.post.*dinebot\/ai-agent/,/^});$/d' /Users/vkumar4/code-test/dine/dine-backend/index.js
sed -i '' '/app.get.*test-schema/,/^});$/d' /Users/vkumar4/code-test/dine/dine-backend/index.js

echo "GraphQL endpoints removed from index.js"


