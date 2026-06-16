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

## Firestore Cost Analysis (2026-06-16)

**Problem:** ₹500/day for 18 restaurants, 150 orders. ~20M reads/month. ~69,000 reads per restaurant per day.

### Profiler Findings (1-hour snapshot, production)

**Top collections by reads:**
| Collection | Reads | % |
|-----------|-------|---|
| orders | 407 | 33% |
| inventory | 257 | 21% |
| restaurants | 138 | 11% |
| tables | 128 | 10% |
| dailyStats | 77 | 6% |
| menuItems | 62 | 5% |
| others | ~172 | 14% |
| **Total** | **1,241** | |

**Top endpoints by reads:**
| Endpoint | Reads | Writes |
|----------|-------|--------|
| GET /api/orders/:restaurantId | 242 | 0 |
| POST /api/orders | 141 | 30 |
| GET /api/kot/:restaurantId | 154 | 0 |
| GET /api/floors/:restaurantId | 101 | 0 |
| GET /api/owner/dashboard | 97 | 0 |

**Writes:** 46 total in 1 hour (not a cost concern — reads dominate 97%)

### Key Insights
- `orders` collection is the #1 cost driver (33% of all reads)
- `GET /api/orders/:restaurantId` alone = 20% of all reads (polls frequently from frontend)
- Inventory reads are high (21%) — likely from stock checks during order placement
- `restaurants` collection read on almost every request (auth/config lookup — mitigated by Redis cache)
- Analytics/Books endpoints were optimized to use `dailyStats` (2026-06-16 session) — previously scanned raw orders

### DailyStats Optimization Done
- Enriched `updateDailyStats()` with: paymentMethod breakdown, categoryBreakdown, totalTax, totalDiscounts, totalRefunds, orderTypeRevenue
- Analytics "today" path now reads 1 dailyStats doc instead of scanning raw orders
- Daily-summary uses dailyStats for category/payment instead of raw order scan
- Books revenue/P&L/overview endpoints use dailyStats batch reads
- Expected daily read reduction: ~800K-1M reads/day saved

### Firestore Query Coupling (migration assessment)
- 153 unique collections, ~9,700 Firestore query calls across codebase
- 56+ files directly use `db` — no repository/data access layer
- 100+ uses of FieldValue.increment(), 21 transactions, 8+ batch writes
- Migration to PostgreSQL requires Phase 0 (abstraction layer) first
- Phase 1 (orders + dailyStats to PostgreSQL) would save 80% of cost

### Profiler Status
- **DISABLED** (2026-06-16) — was consuming too many Redis requests (28K in 30 min)
- Code still exists in `utils/firestoreProfiler.js` and admin UI in `dine-admin` Firestore tab
- To re-enable: uncomment profiler lines in index.js (lines ~133 and ~1480)

## Session Log

### 2026-05-28: Initial CLAUDE.md created
- Documented full architecture, tech stack, patterns, and DB schema

### 2026-06-16: Firestore cost optimization + profiler
- Enriched dailyStats with payment/category/tax fields
- Updated analytics, daily-summary, Books revenue/P&L/overview to use dailyStats
- Built Firestore read/write profiler with per-endpoint tracking (AsyncLocalStorage)
- Added Firestore tab to dine-admin dashboard
- Profiler disabled after gathering data — Redis quota concern
- Documented findings above for future reference
