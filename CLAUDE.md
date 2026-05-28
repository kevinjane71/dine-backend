# dine-backend

## What This Is

Main REST API server for the DineOpen restaurant management platform. Handles POS operations, inventory, billing, AI features, payments, aggregator integrations, and more.

## Tech Stack

- **Runtime**: Node.js with Express 5
- **Database**: Firebase Firestore (named DB: "dine") + Firebase Realtime Database
- **Cache**: Upstash Redis
- **Storage**: Google Cloud Storage (bucket: dine-menu-uploads)
- **Auth**: Firebase Admin + JWT (jsonwebtoken) + bcryptjs
- **Deployment**: Vercel (serverless, primary) + GCP Cloud Run (backup)
- **Testing**: Jest

## Project Structure

```
index.js                  # Main server entry (monolithic, ~34K lines)
firebase.js               # Firestore + RTDB initialization
payment.js                # Razorpay subscription API
dodoPayment.js            # International payments
razorpayOAuth.js          # Restaurant payment OAuth
emailService.js           # Email via Nodemailer
invoiceEmailService.js    # Invoice email notifications

routes/                   # 43+ route modules
  aggregatorRoutes.js     # Talabat integration
  attendance.js           # Staff attendance
  aiInsights.js           # AI analytics
  bolna.js                # Phone agent
  centralKitchenRoutes.js # Multi-location kitchen
  delivery.js             # Delivery management
  dineai.js               # Voice/conversation AI
  feedback.js             # Customer feedback
  gstReports.js           # Tax reporting
  hotel.js                # Hotel features
  inventory.js            # Stock management
  ledger.js               # Accounting
  ownerDashboard.js       # Owner analytics
  parking.js              # Parking management
  payroll.js              # Employee payroll
  superAdmin.js           # Admin panel API
  whatsappOrdering.js     # WhatsApp orders
  bookings/               # Catering/venue booking
  ...

middleware/               # 18 middleware modules
  auth.js                 # JWT verification
  superAdminAuth.js       # Admin role check
  checkPermission.js      # Feature permissions
  orgAccess.js            # Organization isolation
  rateLimiter.js          # Rate limiting
  ...

services/                 # 29 service modules
  inventoryService.js     # Stock logic
  offerEngine.js          # Dynamic pricing
  deliveryService.js      # Delivery logistics
  firebaseRealtimeService.js  # Real-time updates
  fcmService.js           # Push notifications
  sadadService.js         # Saudi payments
  talabatService.js       # Talabat aggregator
  whatsappService.js      # WhatsApp API
  dineai/                 # AI voice system
    DineAIVoiceService.js
    DineAIToolExecutor.js # ~73KB, largest file
    DineAIConversationService.js
    DineAIKnowledgeService.js
    ...
  bolna/                  # Phone agent

utils/
  kvCache.js              # Redis cache layer
  firestoreOptimizer.js   # Query optimization
  timezone.js             # Timezone helpers
```

## Key Patterns

- **Monolithic index.js** (~34K lines) — routes are modular but bootstrapped centrally
- **Lazy initialization** for heavy deps (OpenAI, QRCode, Multer, GCS) to reduce Vercel cold starts
- **Service layer** separates business logic from route handlers
- **Firebase connection reuse** optimized for serverless (ignoreUndefinedProperties)
- **RAG system** for AI chatbots (OpenAI embeddings + Pinecone vector search)

## Database Collections (Firestore)

Core: users, restaurants, menus, menuItems, orders, payments, tables, floors
Inventory: inventory, recipes, purchaseOrders, suppliers, stockBatches, wasteEntries
Customers: customers, customerSegments, loyalty, feedbackResponses
Staff: staffUsers, attendance, leaveRequests, payrollConfig, payrollRuns
Accounting: chartOfAccounts, journalEntries, expenses, ledger, invoices
Enterprise: organizations, orgMenuTemplates, indentRequests, productionOrders
Hotel: hotelRooms, bookings, bookingVenues, spaceBookings
Parking: parkingConfigs, parkingZones, parkingSlots, parkingTickets
AI: automations, automationTemplates, aiUsage, coupons
Payments: subscriptions, dodoPayments

## Auth Flow

1. Login: Firebase Auth (phone/Google/Apple) or staff login (email+password)
2. JWT issued with role + restaurant context
3. All API requests: `Authorization: Bearer {token}`
4. Middleware stack: auth.js -> checkPermission.js -> orgAccess.js
5. Roles: owner, manager, staff, waiter, cashier, kitchen, delivery, customer, super-admin, sub-admin

## Environment

- Dev: `npm run dev` (port 3003)
- Production: Vercel auto-deploy from git
- Env files: `.env`, `.env.local`, `.env.production`
- Key env vars: `JWT_SECRET`, `FIREBASE_*`, `RAZORPAY_*`, `TWILIO_*`, `OPENAI_API_KEY`, `PINECONE_*`, `UPSTASH_*`

## Important Notes

- Backend supports multi-tenancy via restaurant ID scoping
- Talabat webhooks require signature verification (standardwebhooks)
- Real-time updates migrating from Pusher to Firebase RTDB
- AI features have token usage limits (aiUsageLimiter middleware)
- Firestore named database "dine" (not default) — staging uses "dine-staging"

## Session Log

### 2026-05-28: Initial CLAUDE.md created
- Documented full architecture, tech stack, patterns, and DB schema
