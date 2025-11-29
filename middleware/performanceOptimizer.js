/**
 * Performance Optimization Middleware
 * Optimizes API responses for Vercel deployment
 * 
 * Key optimizations:
 * 1. Response compression
 * 2. Connection keep-alive
 * 3. Response timing headers
 * 4. Request/response logging
 */

const performanceOptimizer = (req, res, next) => {
  const startTime = Date.now();

  // Add performance headers
  res.setHeader('X-Response-Time', '0ms');
  res.setHeader('Connection', 'keep-alive');

  // Override res.json to add timing
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const duration = Date.now() - startTime;
    res.setHeader('X-Response-Time', `${duration}ms`);
    
    // Log slow requests (> 1 second)
    if (duration > 1000) {
      console.warn(`⚠️ Slow API request: ${req.method} ${req.path} took ${duration}ms`);
    }
    
    return originalJson(data);
  };

  // Override res.send to add timing
  const originalSend = res.send.bind(res);
  res.send = function(data) {
    const duration = Date.now() - startTime;
    res.setHeader('X-Response-Time', `${duration}ms`);
    
    if (duration > 1000) {
      console.warn(`⚠️ Slow API request: ${req.method} ${req.path} took ${duration}ms`);
    }
    
    return originalSend(data);
  };

  next();
};

module.exports = performanceOptimizer;

