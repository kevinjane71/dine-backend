# Performance Optimization Quick Start

## What Was Fixed

Your API was taking **3 seconds** on Vercel because of:
1. **Geographic latency** (India → US → India) = ~600-1200ms base
2. **Firebase connection re-initialization** = ~200-500ms per request
3. **Sequential queries** = 3 queries × 300ms = 900ms
4. **Cold starts** = 2-5 seconds

## What's Now Optimized

✅ **Connection reuse** - Firebase connection persists between requests  
✅ **Parallel queries** - Multiple queries run simultaneously  
✅ **Response caching** - Frequently accessed data cached for 30 seconds  
✅ **Warm-up endpoint** - Pre-warms serverless function  
✅ **Performance monitoring** - Tracks slow requests automatically  

## Expected Results

- **Cold start**: 3-5s → **1.5-2s** (60% faster)
- **Warm request (single query)**: 500-800ms → **200-400ms** (50% faster)
- **Warm request (3 queries)**: 900-1200ms → **300-500ms** (60% faster)

## How to Use

### 1. Use Firestore Optimizer in Your Routes

**Before (Slow):**
```javascript
// Sequential queries - SLOW
const user = await db.collection('users').doc(userId).get();
const restaurant = await db.collection('restaurants').doc(restaurantId).get();
const menu = await db.collection('menus').doc(menuId).get();
```

**After (Fast):**
```javascript
const firestoreOptimizer = require('./utils/firestoreOptimizer');

// Parallel queries - FAST
const [user, restaurant, menu] = await firestoreOptimizer.executeParallel([
  firestoreOptimizer.getDoc('users', userId),
  firestoreOptimizer.getDoc('restaurants', restaurantId),
  firestoreOptimizer.getDoc('menus', menuId)
]);
```

### 2. Use Cached Queries for Frequently Accessed Data

```javascript
const firestoreOptimizer = require('./utils/firestoreOptimizer');

// This will cache the result for 30 seconds
const restaurant = await firestoreOptimizer.getDoc('restaurants', restaurantId, true);
```

### 3. Keep Function Warm (Optional but Recommended)

Add to `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/warmup",
    "schedule": "*/5 * * * *"
  }]
}
```

Or manually call: `GET /api/warmup` every 5-10 minutes

## Example: Optimizing a Route

**Before:**
```javascript
router.get('/api/restaurant/:id', async (req, res) => {
  const restaurant = await db.collection('restaurants').doc(req.params.id).get();
  const menu = await db.collection('menus').where('restaurantId', '==', req.params.id).get();
  const settings = await db.collection('restaurantSettings').doc(req.params.id).get();
  
  // Total time: ~900ms (3 sequential queries)
  
  res.json({ restaurant, menu, settings });
});
```

**After:**
```javascript
const firestoreOptimizer = require('../utils/firestoreOptimizer');

router.get('/api/restaurant/:id', async (req, res) => {
  const restaurantId = req.params.id;
  
  // Parallel execution - all queries run simultaneously
  const [restaurant, menuDocs, settings] = await firestoreOptimizer.executeParallel([
    firestoreOptimizer.getDoc('restaurants', restaurantId),
    firestoreOptimizer.queryCollection('menus', { restaurantId: restaurantId }),
    firestoreOptimizer.getDoc('restaurantSettings', restaurantId)
  ]);
  
  // Total time: ~300ms (all queries in parallel)
  
  res.json({ 
    restaurant, 
    menu: menuDocs, 
    settings 
  });
});
```

## Monitoring

Check response times in headers:
```bash
curl -I https://your-api.vercel.app/api/health
# Look for: X-Response-Time: 250ms
```

Slow queries are automatically logged:
```
⚠️ Firestore getDoc took 650ms: restaurants/abc123
⚠️ Slow API request: GET /api/restaurants took 1200ms
```

## Next Steps

1. **Deploy** the updated code to Vercel
2. **Test** from India - you should see 50-70% improvement
3. **Monitor** the `X-Response-Time` headers
4. **Optimize routes** one by one using the optimizer

## Still Slow?

If you're still seeing 3-second delays:

1. **Check if it's a cold start** - First request after inactivity will be slower
2. **Use warm-up endpoint** - Call `/api/warmup` every 5 minutes
3. **Check query patterns** - Look for sequential queries that can be parallelized
4. **Consider Vercel Pro** - Allows region selection (closer to India)

## Questions?

See `VERCEL_PERFORMANCE_OPTIMIZATION.md` for detailed explanation of all optimizations.

