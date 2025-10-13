# 🤖 ChatGPT API Usage Limiting System

## Overview
This document outlines the comprehensive ChatGPT API usage limiting system implemented to prevent abuse and control costs. The system tracks both user-based and IP-based limits with dynamic configuration management.

## 🎯 Key Features

### **Dual Tracking System:**
- **User-based limits**: Track calls per authenticated user
- **IP-based limits**: Track calls per IP address (prevents account creation abuse)
- **Daily reset**: Limits reset at midnight UTC
- **Dynamic configuration**: Limits can be updated via database

### **Protected APIs:**
- **Chatbot API** (`/api/dinebot/query`) - Natural language queries
- **Menu Upload API** (`/api/menus/bulk-upload/:restaurantId`) - AI-powered menu extraction

## 📊 Default Configuration

```javascript
{
  dailyLimit: 5,        // Max calls per user per day
  ipLimit: 10,          // Max calls per IP per day  
  userLimit: 5,         // Max calls per user per day
  enabled: true,        // Enable/disable limits
  resetTime: '00:00'    // UTC reset time
}
```

## 🗄️ Database Structure

### **Firestore Collections:**

#### **`chatgptUsage` Collection:**
```javascript
// User usage document: {userId}_{YYYY-MM-DD}
{
  userId: "user123",
  date: "2024-12-21",
  callCount: 3,
  lastCallAt: "2024-12-21T10:30:00Z",
  ipAddresses: ["192.168.1.100"],
  totalTokensUsed: 0,
  createdAt: "2024-12-21T09:00:00Z"
}

// IP usage document: ip_{ipAddress}_{YYYY-MM-DD}
{
  ipAddress: "192.168.1.100",
  date: "2024-12-21", 
  callCount: 5,
  lastCallAt: "2024-12-21T10:30:00Z",
  userIds: ["user123", "user456"],
  totalTokensUsed: 0,
  createdAt: "2024-12-21T09:00:00Z"
}
```

#### **`systemConfig` Collection:**
```javascript
// Configuration document: chatgptLimits
{
  dailyLimit: 5,
  ipLimit: 10,
  userLimit: 5,
  enabled: true,
  updatedAt: "2024-12-21T10:30:00Z",
  updatedBy: "admin"
}
```

## 🔧 API Endpoints

### **User Endpoints:**

#### **Check Usage:**
```http
GET /api/chatgpt/usage
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "usage": {
    "user": {
      "callCount": 3,
      "limit": 5,
      "remaining": 2,
      "lastCallAt": "2024-12-21T10:30:00Z"
    },
    "ip": {
      "callCount": 5,
      "limit": 10,
      "remaining": 5,
      "lastCallAt": "2024-12-21T10:30:00Z"
    },
    "config": {
      "enabled": true,
      "resetTime": "2024-12-22T00:00:00Z"
    }
  }
}
```

### **Admin Endpoints:**

#### **Get Statistics:**
```http
GET /api/admin/chatgpt/stats
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "totalCalls": 150,
    "totalTokens": 0,
    "uniqueUsers": 25,
    "uniqueIPs": 12,
    "config": {
      "dailyLimit": 5,
      "ipLimit": 10,
      "userLimit": 5,
      "enabled": true
    },
    "timestamp": "2024-12-21T10:30:00Z"
  }
}
```

#### **Update Configuration:**
```http
POST /api/admin/chatgpt/config
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "dailyLimit": 10,
  "ipLimit": 20,
  "userLimit": 10,
  "enabled": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "ChatGPT limits configuration updated successfully",
  "config": {
    "dailyLimit": 10,
    "ipLimit": 20,
    "userLimit": 10,
    "enabled": true
  }
}
```

#### **Cleanup Old Data:**
```http
POST /api/admin/chatgpt/cleanup
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "message": "Old ChatGPT usage data cleaned up successfully"
}
```

## 🚨 Error Responses

### **Limit Exceeded:**
```json
{
  "error": "Daily ChatGPT API limit exceeded",
  "code": "CHATGPT_LIMIT_EXCEEDED",
  "reason": "User daily limit exceeded",
  "limitType": "user",
  "currentUsage": 5,
  "limit": 5,
  "resetTime": "2024-12-22T00:00:00Z",
  "message": "Your daily ChatGPT API limit has been reached. Please try again tomorrow."
}
```

### **Authentication Required:**
```json
{
  "error": "Authentication required for ChatGPT API calls",
  "code": "AUTH_REQUIRED"
}
```

## 🔄 How It Works

### **1. Request Flow:**
```
User Request → Authentication → ChatGPT Middleware → Usage Check → API Call → Usage Recording
```

### **2. Usage Check Process:**
1. **Extract user ID** from JWT token
2. **Extract IP address** from request headers
3. **Check user limits** - Get today's usage for user
4. **Check IP limits** - Get today's usage for IP
5. **Compare against config** - Check if limits exceeded
6. **Allow/Block request** - Return appropriate response

### **3. Usage Recording Process:**
1. **Record user usage** - Increment call count for user
2. **Record IP usage** - Increment call count for IP
3. **Update timestamps** - Set last call time
4. **Track tokens** - Record token usage (if available)

### **4. Daily Reset Process:**
1. **Automatic reset** - Limits reset at midnight UTC
2. **New day tracking** - Create new documents for new day
3. **Cleanup old data** - Remove usage data older than 30 days

## 🛡️ Security Features

### **IP-Based Protection:**
- **Prevents account abuse** - Same IP can't create multiple accounts
- **Shared network handling** - Higher IP limits for shared networks
- **VPN detection** - Can identify suspicious IP patterns

### **User-Based Protection:**
- **Per-user limits** - Each user has individual limits
- **Authentication required** - Must be logged in to use ChatGPT APIs
- **Role-based access** - Admin users can manage limits

### **Graceful Degradation:**
- **Database errors** - Allow requests if database is down
- **Config errors** - Use default limits if config fails
- **Service availability** - Prioritize service over limits

## 📈 Monitoring & Analytics

### **Real-time Metrics:**
- **Total calls today** - Across all users and IPs
- **Unique users** - Number of users who made calls
- **Unique IPs** - Number of IPs that made calls
- **Token usage** - Total tokens consumed (if tracked)

### **Usage Patterns:**
- **Peak hours** - When most calls are made
- **User behavior** - Which users make most calls
- **IP distribution** - Geographic distribution of calls
- **Limit effectiveness** - How often limits are hit

### **Admin Dashboard Data:**
```javascript
// Available via /api/admin/chatgpt/stats
{
  totalCalls: 150,        // Total calls today
  totalTokens: 0,         // Total tokens used
  uniqueUsers: 25,        // Unique users today
  uniqueIPs: 12,         // Unique IPs today
  config: { ... },       // Current configuration
  timestamp: "..."       // Last updated
}
```

## 🔧 Configuration Management

### **Dynamic Updates:**
- **Real-time changes** - Config updates take effect immediately
- **No restart required** - Changes applied without server restart
- **Admin control** - Only admin/owner can update limits
- **Audit trail** - Track who changed what and when

### **Configuration Options:**
```javascript
{
  dailyLimit: 5,          // Max calls per user per day
  ipLimit: 10,           // Max calls per IP per day
  userLimit: 5,          // Max calls per user per day (alias for dailyLimit)
  enabled: true,          // Enable/disable all limits
  resetTime: "00:00"     // UTC time for daily reset
}
```

### **Environment Variables:**
```bash
# Optional: Override default limits
CHATGPT_USER_LIMIT=5
CHATGPT_IP_LIMIT=10
CHATGPT_ENABLED=true
```

## 💰 Cost Management

### **Token Tracking:**
- **Optional tracking** - Can track actual token usage
- **Cost estimation** - Calculate approximate costs
- **Usage optimization** - Identify high-cost operations
- **Budget alerts** - Set up spending alerts

### **Limit Optimization:**
- **Usage analysis** - Analyze actual usage patterns
- **Limit tuning** - Adjust limits based on usage
- **Cost control** - Set limits to control spending
- **Fair usage** - Ensure fair access for all users

## 🚀 Deployment Considerations

### **Vercel Compatibility:**
- **Stateless design** - Works with serverless functions
- **Firestore storage** - Uses existing database
- **No Redis needed** - Pure database solution
- **Auto-scaling** - Handles traffic spikes

### **Performance:**
- **Minimal overhead** - Only 2-3 database reads per request
- **Efficient queries** - Indexed Firestore queries
- **Caching friendly** - Can add caching layer if needed
- **Error resilient** - Graceful degradation on errors

### **Monitoring:**
- **Firestore metrics** - Monitor database usage
- **Function metrics** - Monitor serverless function performance
- **Cost tracking** - Monitor ChatGPT API costs
- **Usage analytics** - Track usage patterns

## 🔍 Testing

### **Local Testing:**
```bash
# Test user limits
curl -X GET "http://localhost:3003/api/chatgpt/usage" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test admin stats
curl -X GET "http://localhost:3003/api/admin/chatgpt/stats" \
  -H "Authorization: Bearer ADMIN_TOKEN"

# Test limit update
curl -X POST "http://localhost:3003/api/admin/chatgpt/config" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dailyLimit": 10, "ipLimit": 20}'
```

### **Production Testing:**
- **Load testing** - Test with multiple concurrent users
- **Limit testing** - Verify limits work correctly
- **Error testing** - Test error handling
- **Reset testing** - Verify daily reset works

## 📞 Troubleshooting

### **Common Issues:**

#### **Limits Not Working:**
- Check Firestore permissions
- Verify configuration in database
- Review function logs for errors
- Test with admin endpoints

#### **High Database Costs:**
- Review cleanup frequency
- Check for unnecessary reads/writes
- Optimize query patterns
- Monitor Firestore usage

#### **False Positives:**
- Check IP detection logic
- Verify user identification
- Review shared network handling
- Test with different IPs

### **Debug Commands:**
```bash
# Check current usage
curl "https://your-app.vercel.app/api/chatgpt/usage" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check admin stats
curl "https://your-app.vercel.app/api/admin/chatgpt/stats" \
  -H "Authorization: Bearer ADMIN_TOKEN"

# View Firestore data
# Use Firebase Console to inspect collections
```

---

**Last Updated**: December 2024  
**Version**: 1.0  
**Status**: Production Ready ✅  
**Compatibility**: Vercel Serverless Functions ✅
