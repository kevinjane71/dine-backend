# 🌐 Subdomain System for Restaurant Menus

## Overview
This document outlines the complete subdomain system implementation that allows each restaurant to have its own branded URL like `restaurant-name.dineopen.com` for their public menu.

## 🎯 Key Features

### **Branded URLs:**
- **Custom subdomains**: `restaurant-name.dineopen.com`
- **Automatic generation**: Subdomains created from restaurant names
- **Unique validation**: Ensures no duplicate subdomains
- **Professional appearance**: Clean, branded URLs for customers

### **QR Code Integration:**
- **Subdomain QR codes**: QR codes point to subdomain URLs
- **Automatic updates**: QR codes regenerate when subdomain changes
- **Easy sharing**: Simple URLs for customers to remember

### **Dynamic Routing:**
- **Middleware detection**: Automatically detects subdomains
- **Restaurant lookup**: Finds restaurant by subdomain
- **Fallback handling**: Graceful error handling for invalid subdomains

## 🏗️ Architecture Overview

### **Request Flow:**
```
Customer scans QR → restaurant-name.dineopen.com → Middleware detects subdomain → 
Lookup restaurant by subdomain → Redirect to menu page with restaurant ID
```

### **Components:**
- **DNS Configuration**: Wildcard subdomain routing
- **Vercel Middleware**: Subdomain detection and routing
- **Backend API**: Restaurant lookup by subdomain
- **Frontend Pages**: Dynamic restaurant page handling
- **QR Code Generation**: Subdomain-based QR codes

## 🔧 Implementation Details

### **1. DNS Configuration**

#### **Wildcard DNS Record:**
```
Type: CNAME
Name: *
Value: cname.vercel-dns.com
TTL: 300
```

This routes all subdomains (`*.dineopen.com`) to Vercel.

### **2. Vercel Middleware**

#### **Subdomain Detection:**
```javascript
// src/middleware.js
export function middleware(request) {
  const hostname = request.headers.get('host') || '';
  const subdomain = hostname.split('.')[0];
  
  const isSubdomain = hostname.includes('.') && 
                     !hostname.startsWith('www.') && 
                     subdomain !== 'api' && 
                     subdomain !== 'admin';
  
  if (isSubdomain) {
    url.pathname = `/restaurant/${subdomain}`;
    return NextResponse.rewrite(url);
  }
}
```

### **3. Dynamic Restaurant Page**

#### **Subdomain Handling:**
```javascript
// src/app/restaurant/[subdomain]/page.js
useEffect(() => {
  const hostname = window.location.hostname;
  const subdomain = hostname.split('.')[0];
  
  // Fetch restaurant by subdomain
  const response = await fetch(`/api/public/restaurant-by-subdomain/${subdomain}`);
  
  if (response.ok) {
    const data = await response.json();
    setRestaurant(data.restaurant);
    // Redirect to menu page
    router.push(`/placeorder?restaurant=${restaurant.id}`);
  }
}, []);
```

### **4. Backend API**

#### **Restaurant Lookup:**
```javascript
// GET /api/public/restaurant-by-subdomain/:subdomain
app.get('/api/public/restaurant-by-subdomain/:subdomain', async (req, res) => {
  const { subdomain } = req.params;
  
  const snapshot = await db.collection('restaurants')
    .where('subdomain', '==', subdomain)
    .where('isActive', '==', true)
    .limit(1)
    .get();
    
  if (snapshot.empty) {
    return res.status(404).json({ error: 'Restaurant not found' });
  }
  
  const restaurant = snapshot.docs[0].data();
  res.json({ success: true, restaurant });
});
```

### **5. Subdomain Generation**

#### **Automatic Generation:**
```javascript
const generateSubdomain = (restaurantName) => {
  return restaurantName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .substring(0, 30); // Limit length
};

// Check uniqueness and add counter if needed
let finalSubdomain = subdomain;
let counter = 1;

while (await isSubdomainTaken(finalSubdomain)) {
  finalSubdomain = `${subdomain}-${counter}`;
  counter++;
}
```

## 📊 Database Structure

### **Restaurant Collection Updates:**
```javascript
{
  id: "restaurant123",
  name: "Pizza Palace",
  subdomain: "pizza-palace", // New field
  isActive: true, // New field
  qrData: "https://pizza-palace.dineopen.com", // Updated QR data
  qrCode: "data:image/png;base64...", // Updated QR code
  // ... other fields
}
```

### **Subdomain Validation:**
- **Format**: `^[a-z0-9-]+$` (lowercase letters, numbers, hyphens only)
- **Length**: 3-30 characters
- **Uniqueness**: No duplicate subdomains
- **Reserved words**: Avoids `www`, `api`, `admin`, etc.

## 🔄 QR Code Integration

### **QR Code Generation:**
```javascript
// Generate QR code with subdomain URL
const qrData = `https://${subdomain}.dineopen.com`;
const qrCode = await QRCode.toDataURL(qrData);

// Update restaurant record
await restaurantRef.update({ qrCode, qrData });
```

### **QR Code Modal Updates:**
```javascript
// QRCodeModal component
const qrUrl = restaurantSubdomain 
  ? `https://${restaurantSubdomain}.dineopen.com`
  : `${baseUrl}/placeorder?restaurant=${restaurantId}`;
```

## 🛠️ Management APIs

### **Update Subdomain:**
```http
PUT /api/restaurants/:restaurantId/subdomain
Authorization: Bearer <token>
Content-Type: application/json

{
  "subdomain": "new-restaurant-name"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Subdomain updated successfully",
  "subdomain": "new-restaurant-name",
  "qrData": "https://new-restaurant-name.dineopen.com"
}
```

### **Check Availability:**
```http
GET /api/restaurants/subdomain-availability/:subdomain
Authorization: Bearer <token>
```

**Response:**
```json
{
  "available": true,
  "subdomain": "pizza-palace"
}
```

**Or if taken:**
```json
{
  "available": false,
  "reason": "Subdomain is already taken"
}
```

## 🚀 Deployment Steps

### **1. DNS Configuration:**
1. **Login to domain provider** (GoDaddy, Namecheap, etc.)
2. **Add wildcard CNAME record:**
   - Type: `CNAME`
   - Name: `*`
   - Value: `cname.vercel-dns.com`
   - TTL: `300`

### **2. Vercel Configuration:**
1. **Deploy frontend** with updated `vercel.json`
2. **Deploy backend** with subdomain APIs
3. **Test subdomain routing** with sample subdomains

### **3. Database Migration:**
1. **Add subdomain field** to existing restaurants
2. **Generate subdomains** for existing restaurants
3. **Update QR codes** with new subdomain URLs

## 📱 User Experience

### **Customer Journey:**
1. **Scan QR code** → Opens `restaurant-name.dineopen.com`
2. **Automatic redirect** → Loads restaurant menu
3. **Branded experience** → Clean, professional URL
4. **Easy sharing** → Simple URL to share with friends

### **Restaurant Owner Journey:**
1. **Create restaurant** → Subdomain auto-generated
2. **QR code created** → Points to subdomain
3. **Share QR code** → Customers get branded URL
4. **Update subdomain** → QR code automatically updates

## 🔍 Testing

### **Local Testing:**
```bash
# Test subdomain API
curl "http://localhost:3003/api/public/restaurant-by-subdomain/pizza-palace"

# Test subdomain availability
curl "http://localhost:3003/api/restaurants/subdomain-availability/pizza-palace" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test subdomain update
curl -X PUT "http://localhost:3003/api/restaurants/RESTAURANT_ID/subdomain" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "new-name"}'
```

### **Production Testing:**
1. **Create test restaurant** with subdomain
2. **Generate QR code** and scan it
3. **Verify subdomain** loads correctly
4. **Test subdomain updates** and QR regeneration

## 🛡️ Security Considerations

### **Subdomain Validation:**
- **Format validation** prevents malicious subdomains
- **Length limits** prevent abuse
- **Character restrictions** ensure safe URLs
- **Uniqueness checks** prevent conflicts

### **Access Control:**
- **Owner-only updates** for subdomain changes
- **Authentication required** for management APIs
- **Restaurant ownership** validation
- **Active status** checks for public access

### **Error Handling:**
- **Graceful fallbacks** for invalid subdomains
- **404 handling** for non-existent restaurants
- **Rate limiting** on subdomain APIs
- **Input sanitization** for all subdomain inputs

## 📈 Benefits

### **For Customers:**
- **Easy to remember** URLs
- **Professional appearance** 
- **Direct access** to restaurant menus
- **Branded experience**

### **For Restaurants:**
- **Professional branding**
- **Easy QR code sharing**
- **Custom domain feel**
- **Better customer experience**

### **For Platform:**
- **Scalable architecture**
- **Professional appearance**
- **Better SEO** for restaurants
- **Enhanced user experience**

## 🔧 Maintenance

### **Regular Tasks:**
- **Monitor subdomain usage** and conflicts
- **Clean up inactive** subdomains
- **Update DNS** if needed
- **Monitor performance** of subdomain routing

### **Monitoring:**
- **Subdomain creation** rates
- **QR code scan** analytics
- **Error rates** for invalid subdomains
- **Performance metrics** for subdomain lookups

---

**Last Updated**: December 2024  
**Version**: 1.0  
**Status**: Production Ready ✅  
**Compatibility**: Vercel + Next.js ✅
