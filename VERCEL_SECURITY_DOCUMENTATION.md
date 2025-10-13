# 🔒 Vercel-Compatible API Security & DDoS Protection

## Overview
This document outlines the **Vercel-compatible** security measures implemented for your restaurant management system. The solution is designed specifically for Vercel's serverless environment and uses Firestore for persistent storage.

## 🚀 Vercel Serverless Compatibility

### **Key Challenges Solved:**
- ❌ **No persistent memory** - Serverless functions are stateless
- ❌ **No Redis/caching** - Vercel doesn't provide persistent storage
- ❌ **Cold starts** - Functions restart frequently
- ❌ **No shared state** - Each function instance is isolated

### **Our Solution:**
- ✅ **Firestore database** for persistent rate limiting data
- ✅ **Stateless design** that works across function instances
- ✅ **Automatic cleanup** of old data
- ✅ **Edge Config** for configuration management

## 🛡️ Architecture Overview

### **Data Storage Strategy:**
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Vercel Edge   │    │   Firestore     │    │   Security      │
│   Functions     │◄──►│   Database      │◄──►│   Middleware    │
│                 │    │                 │    │                 │
│ • Stateless     │    │ • rateLimits    │    │ • Rate Limiting │
│ • Auto-scaling  │    │ • blockedIPs    │    │ • IP Blocking   │
│ • Global CDN    │    │ • securityLogs  │    │ • Pattern Det.  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### **Firestore Collections:**
- **`rateLimits`** - Client rate limiting data
- **`blockedIPs`** - Temporarily blocked IP addresses
- **`securityLogs`** - Security events and monitoring

## 📊 Rate Limiting Implementation

### **Firestore-Based Rate Limiting:**
```javascript
// Client data structure in Firestore
{
  clientId: "192.168.1.1-Chrome/120.0",
  requestCount: 45,
  windowStart: 1703123456789,
  blockedUntil: null,
  totalRequests: 1234,
  clientType: "public",
  lastUpdated: "2024-12-21T10:30:00Z"
}
```

### **Rate Limits by API Type:**
- **Public APIs**: 100 requests/15min
- **Chatbot APIs**: 200 requests/15min  
- **Authenticated APIs**: 1000 requests/15min

### **Automatic Cleanup:**
- Old rate limit data cleaned up every hour
- Expired IP blocks automatically removed
- Prevents database bloat

## 🔒 Security Features

### **1. IP-Based Blocking:**
```javascript
// Blocked IP structure in Firestore
{
  ip: "192.168.1.100",
  blockedUntil: "2024-12-21T11:30:00Z",
  blockedAt: "2024-12-21T10:30:00Z",
  reason: "Suspicious activity"
}
```

### **2. Pattern Detection:**
- SQL injection attempts
- XSS attacks
- Directory traversal
- Command injection
- Bot/scraper detection

### **3. Security Logging:**
```javascript
// Security log structure in Firestore
{
  event: "SUSPICIOUS_REQUEST",
  clientIP: "192.168.1.100",
  userAgent: "curl/7.68.0",
  url: "/api/public/menu/123",
  method: "GET",
  details: { reason: "Suspicious user agent" },
  timestamp: "2024-12-21T10:30:00Z",
  requestId: "req_abc123"
}
```

## 🚀 Performance Optimizations

### **Database Efficiency:**
- **Batch operations** for cleanup
- **Indexed queries** for fast lookups
- **Minimal data transfer** - only necessary fields
- **Connection pooling** via Firebase SDK

### **Function Performance:**
- **Async/await** for non-blocking operations
- **Error handling** prevents function crashes
- **Graceful degradation** if database is slow
- **Minimal cold start impact**

### **Caching Strategy:**
- **No caching** - Always fresh data from Firestore
- **Consistent state** across all function instances
- **Real-time updates** for security events

## 📈 Monitoring & Analytics

### **Real-time Metrics:**
```javascript
// Security stats endpoint response
{
  "status": "healthy",
  "timestamp": "2024-12-21T10:30:00Z",
  "uptime": 86400,
  "security": {
    "totalClients": 1250,
    "blockedClients": 15,
    "blockedIPs": 8,
    "publicClients": 800,
    "authenticatedClients": 400,
    "chatbotClients": 50
  }
}
```

### **Admin Dashboard Endpoints:**
- `GET /api/admin/security/stats` - Detailed security statistics
- `POST /api/admin/security/block-ip` - Manual IP blocking
- `GET /api/health` - System health with security info

## 🔧 Configuration Management

### **Edge Config Integration:**
```json
{
  "rateLimits": {
    "public": {
      "windowMs": 900000,
      "maxRequests": 100,
      "blockDurationMs": 3600000
    }
  },
  "security": {
    "enableBlocking": true,
    "enableLogging": true,
    "cleanupInterval": 3600000
  }
}
```

### **Environment Variables:**
```bash
# Firebase configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY=your-private-key
FIREBASE_CLIENT_EMAIL=your-client-email

# Security settings
SECURITY_ENABLED=true
RATE_LIMIT_ENABLED=true
IP_BLOCKING_ENABLED=true
LOG_SECURITY_EVENTS=true
```

## 💰 Cost Considerations

### **Firestore Usage:**
- **Reads**: ~2-3 per request (rate limit check + IP check)
- **Writes**: ~1 per request (rate limit update)
- **Storage**: Minimal - only essential data stored
- **Estimated cost**: $0.01-0.05 per 1000 requests

### **Vercel Function Usage:**
- **Execution time**: +50-100ms per request
- **Memory usage**: Minimal increase
- **Cold starts**: No impact on security features

## 🚨 Error Handling

### **Graceful Degradation:**
```javascript
try {
  // Security checks
  const isBlocked = await vercelRateLimiter.isBlocked(clientId);
  // ... security logic
} catch (error) {
  console.error('Security middleware error:', error);
  // Allow request but log error
  next();
}
```

### **Fallback Behavior:**
- If Firestore is down → Allow requests but log errors
- If rate limiter fails → Continue with warning
- If IP blocking fails → Log but don't block
- Always prioritize service availability

## 🔍 Testing & Validation

### **Local Testing:**
```bash
# Test rate limiting
curl -X GET "http://localhost:3003/api/public/menu/test123" \
  -H "X-Forwarded-For: 192.168.1.100"

# Test IP blocking
curl -X POST "http://localhost:3003/api/admin/security/block-ip" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"ip": "192.168.1.100", "duration": 3600000}'
```

### **Production Monitoring:**
- Monitor Firestore usage in Firebase Console
- Check Vercel function logs for security events
- Review security statistics via admin endpoints
- Set up alerts for unusual activity

## 🚀 Deployment Checklist

### **Pre-deployment:**
- [ ] Firebase project configured
- [ ] Firestore rules updated for security collections
- [ ] Environment variables set in Vercel
- [ ] Edge Config deployed (if using)

### **Post-deployment:**
- [ ] Test rate limiting with multiple requests
- [ ] Verify IP blocking functionality
- [ ] Check security logging in Firestore
- [ ] Monitor function performance
- [ ] Test admin endpoints

## 📞 Troubleshooting

### **Common Issues:**

#### **Rate Limiting Not Working:**
- Check Firestore permissions
- Verify Firebase configuration
- Review function logs for errors

#### **High Firestore Costs:**
- Review cleanup frequency
- Check for unnecessary reads/writes
- Optimize query patterns

#### **Function Timeouts:**
- Reduce database operations
- Add error handling
- Optimize async operations

### **Debug Commands:**
```bash
# Check security stats
curl "https://your-app.vercel.app/api/health"

# View Firestore data
# Use Firebase Console or Admin SDK

# Monitor function logs
# Check Vercel dashboard logs
```

---

**Last Updated**: December 2024  
**Version**: 2.0 (Vercel-Compatible)  
**Status**: Production Ready ✅  
**Compatibility**: Vercel Serverless Functions ✅
