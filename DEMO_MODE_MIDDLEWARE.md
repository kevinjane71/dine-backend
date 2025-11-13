# Demo Mode Restrictions Middleware

This middleware provides read-only access for demo accounts (phone: +919000000000) and prevents them from performing destructive operations.

## Features

- **Read-Only Access**: Demo accounts can only perform GET requests
- **Blocked Operations**: POST, PUT, PATCH, DELETE requests are blocked for demo accounts
- **Clear Error Messages**: Informative error responses explaining demo restrictions
- **Easy Integration**: Simple helper functions to apply restrictions

## Usage

### 1. Basic Demo Restrictions (Read-Only)

Apply read-only restrictions to routes that demo accounts should be able to view but not modify:

```javascript
// Before
app.post('/api/menus/:restaurantId', authenticateToken, async (req, res) => {
  // Route handler
});

// After
app.post('/api/menus/:restaurantId', ...withDemoRestrictions([]), async (req, res) => {
  // Route handler
});
```

### 2. Complete Block for Demo Accounts

Block demo accounts completely from certain routes:

```javascript
// Before
app.post('/api/menus/bulk-upload/:restaurantId', authenticateToken, upload.array('files'), async (req, res) => {
  // Route handler
});

// After
app.post('/api/menus/bulk-upload/:restaurantId', ...blockDemo([upload.array('files')]), async (req, res) => {
  // Route handler
});
```

### 3. Add Demo Mode Info

Add demo mode information to responses:

```javascript
app.get('/api/some-endpoint', authenticateToken, addDemoModeInfo, async (req, res) => {
  res.json({
    data: someData,
    demoMode: res.locals.demoMode,
    demoRestrictions: res.locals.demoRestrictions
  });
});
```

## Helper Functions

### `withDemoRestrictions(middleware)`
- Applies `authenticateToken` + `demoModeRestrictions` + your middleware
- Demo accounts can only perform GET requests
- Returns 403 for non-GET requests with helpful error message

### `blockDemo(middleware)`
- Applies `authenticateToken` + `blockDemoAccount` + your middleware
- Completely blocks demo accounts from accessing the route
- Returns 403 with explanation that feature is not available in demo mode

### `addDemoModeInfo`
- Adds demo mode information to `res.locals`
- Use `res.locals.demoMode` and `res.locals.demoRestrictions` in your responses

## Demo Account Detection

The middleware automatically detects demo accounts by phone number:
- `+919000000000`
- `9000000000`
- `+91-9000000000`

## Error Responses

### Read-Only Restriction (403)
```json
{
  "success": false,
  "error": "Demo Mode Restriction",
  "message": "Demo accounts are restricted to read-only access. Please sign up for a full account to perform this action.",
  "demoMode": true,
  "allowedOperations": ["GET"],
  "restrictedOperations": ["POST", "PUT", "PATCH", "DELETE"]
}
```

### Complete Block (403)
```json
{
  "success": false,
  "error": "Demo Mode Blocked",
  "message": "This feature is not available in demo mode. Please sign up for a full account.",
  "demoMode": true,
  "blockedRoute": "POST /api/some-endpoint"
}
```

## Applied Routes

The following routes have been updated with demo restrictions:

### Read-Only Restrictions (withDemoRestrictions)
- `POST /api/restaurants` - Restaurant creation
- `PATCH /api/restaurants/:restaurantId` - Restaurant updates
- `POST /api/menus/:restaurantId` - Menu item creation
- `PATCH /api/menus/item/:id` - Menu item updates
- `DELETE /api/menus/item/:id` - Menu item deletion
- `PATCH /api/orders/:orderId/status` - Order status updates

### Complete Block (blockDemo)
- `POST /api/menus/bulk-upload/:restaurantId` - Bulk menu upload

### Test Endpoints
- `GET /api/test/demo-mode` - Test demo mode detection
- `POST /api/test/demo-mode` - Test demo restrictions

## Testing

1. Login with demo account (phone: 9000000000, OTP: 1234)
2. Try GET requests - should work normally
3. Try POST/PUT/PATCH/DELETE requests - should return 403 with demo restriction message
4. Try bulk upload - should return 403 with demo blocked message

## Benefits

- **Minimal Code Changes**: Uses helper functions to apply restrictions
- **No API Changes**: Existing API responses remain the same for regular users
- **Clear User Experience**: Demo users get helpful error messages
- **Easy Maintenance**: Centralized demo account logic
- **Flexible**: Can be applied to any route with minimal changes




