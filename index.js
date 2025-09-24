const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
// const twilio = require('twilio');
// const Razorpay = require('razorpay');
require('dotenv').config();

const { db, collections } = require('./firebase');

const app = express();
const PORT = process.env.PORT || 3003;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
// const razorpay = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET
// });

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3002',
      'http://localhost:3003',
      'https://dine-frontend.vercel.app',
      'https://dine-frontend-ecru.vercel.app',
      'https://dine-backend-lake.vercel.app',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    if (process.env.NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://192.168.')) {
        return callback(null, true);
      }
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors(corsOptions));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  req.id = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-Request-ID', req.id);
  next();
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

const generateOTP = () => {
  return "1234";
};

const sendOTP = async (phone, otp) => {
  try {
    // await twilioClient.messages.create({
    //   body: `Your Dine verification code is: ${otp}. Valid for 10 minutes.`,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: phone
    // });
    console.log(`📱 SMS OTP for ${phone}: ${otp} (Twilio disabled)`);
    return true;
  } catch (error) {
    console.error('SMS Error:', error);
    return false;
  }
};

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    message: '🍽️ Dine Restaurant Management System is running!',
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🍽️ Welcome to Dine - Restaurant Management System!',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    features: [
      '📱 QR Code Digital Menus',
      '🛒 Table-side Ordering',
      '💳 Multiple Payment Options', 
      '👨‍🍳 Kitchen Order Tickets',
      '📊 Analytics Dashboard',
      '🔐 Multi-auth System'
    ],
    endpoints: {
      health: '/health',
      auth: '/api/auth/*',
      restaurants: '/api/restaurants/*',
      menus: '/api/menus/*',
      orders: '/api/orders/*',
      payments: '/api/payments/*'
    }
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, phone, restaurantName, role = 'owner' } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    const existingUser = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailOTP = generateOTP();

    const userData = {
      email,
      password: hashedPassword,
      name,
      phone: phone || null,
      role,
      restaurantName: restaurantName || null,
      emailVerified: false,
      phoneVerified: false,
      emailOTP,
      emailOTPExpiry: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const userRef = await db.collection(collections.users).add(userData);
    
    console.log(`📧 Email verification OTP for ${email}: ${emailOTP}`);

    res.status(201).json({
      message: 'User registered successfully. Please verify your email.',
      userId: userRef.id,
      verificationRequired: true
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const userQuery = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (userQuery.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (userData.emailOTP !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (new Date() > userData.emailOTPExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    await userDoc.ref.update({
      emailVerified: true,
      emailOTP: null,
      emailOTPExpiry: null,
      updatedAt: new Date()
    });

    const token = jwt.sign(
      { userId: userDoc.id, email: userData.email, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Email verified successfully',
      token,
      user: {
        id: userDoc.id,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        emailVerified: true
      }
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const userQuery = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!userData.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email first' });
    }

    const token = jwt.sign(
      { userId: userDoc.id, email: userData.email, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: userDoc.id,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        restaurantName: userData.restaurantName
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    let userDoc = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    let userId;

    if (userDoc.empty) {
      const newUser = {
        email,
        name,
        picture,
        role: 'customer',
        emailVerified: true,
        phoneVerified: false,
        provider: 'google',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
    } else {
      userId = userDoc.docs[0].id;
      await userDoc.docs[0].ref.update({
        updatedAt: new Date(),
        picture: picture || userDoc.docs[0].data().picture
      });
    }

    const jwtToken = jwt.sign(
      { userId, email, role: userDoc.empty ? 'customer' : userDoc.docs[0].data().role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Google login successful',
      token: jwtToken,
      user: {
        id: userId,
        email,
        name,
        picture,
        role: userDoc.empty ? 'customer' : userDoc.docs[0].data().role
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

app.post('/api/auth/phone/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    const otpRecord = {
      phone,
      otp,
      otpExpiry,
      createdAt: new Date()
    };

    await db.collection('otp_verification').add(otpRecord);

    const smsSent = await sendOTP(phone, otp);

    if (!smsSent) {
      console.log(`📱 SMS OTP for ${phone}: ${otp}`);
    }

    res.json({
      message: 'OTP sent successfully',
      success: true
    });

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Owner phone-based registration/login
app.post('/api/auth/phone/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const otpQuery = await db.collection('otp_verification')
      .where('phone', '==', phone)
      .where('otp', '==', otp)
      .limit(1)
      .get();

    if (otpQuery.empty) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    const otpDoc = otpQuery.docs[0];
    const otpData = otpDoc.data();

    if (new Date() > otpData.otpExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    let userDoc = await db.collection(collections.users)
      .where('phone', '==', phone)
      .get();

    let userId, isNewUser = false, hasRestaurants = false;

    if (userDoc.empty) {
      // New owner registration
      const newUser = {
        phone,
        name: name || 'Restaurant Owner',
        role: 'owner',
        emailVerified: false,
        phoneVerified: true,
        provider: 'phone',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
    } else {
      // Existing owner login
      const userData = userDoc.docs[0].data();
      userId = userDoc.docs[0].id;
      
      await userDoc.docs[0].ref.update({
        phoneVerified: true,
        updatedAt: new Date()
      });

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      hasRestaurants = !restaurantsQuery.empty;
    }

    await otpDoc.ref.delete();

    const token = jwt.sign(
      { userId, phone, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Phone verification successful',
      token,
      user: {
        id: userId,
        phone,
        name: name || userDoc.docs[0]?.data()?.name || 'Restaurant Owner',
        role: 'owner'
      },
      isNewUser,
      hasRestaurants,
      redirectTo: isNewUser || !hasRestaurants ? '/admin' : '/admin'
    });

  } catch (error) {
    console.error('Phone verification error:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Phone verification failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/restaurants', authenticateToken, async (req, res) => {
  try {
    const { userId, role } = req.user;

    let query = db.collection(collections.restaurants);

    if (role !== 'admin') {
      query = query.where('ownerId', '==', userId);
    }

    const snapshot = await query.get();
    const restaurants = [];

    snapshot.forEach(doc => {
      restaurants.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ restaurants });

  } catch (error) {
    console.error('Get restaurants error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

app.post('/api/restaurants', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user;
    const { 
      name, 
      address, 
      phone, 
      email, 
      cuisine, 
      description,
      operatingHours,
      features 
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Restaurant name is required' });
    }

    const restaurantData = {
      name,
      address: address || null,
      city: req.body.city || null,
      phone: phone || null,
      email: email || null,
      cuisine: cuisine || [],
      description: description || '',
      operatingHours: operatingHours || {},
      features: features || [],
      ownerId: userId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const restaurantRef = await db.collection(collections.restaurants).add(restaurantData);

    const qrData = `${process.env.FRONTEND_URL}/menu/${restaurantRef.id}`;
    const qrCode = await QRCode.toDataURL(qrData);

    await restaurantRef.update({ qrCode, qrData });

    res.status(201).json({
      message: 'Restaurant created successfully',
      restaurant: {
        id: restaurantRef.id,
        ...restaurantData,
        qrCode,
        qrData
      }
    });

  } catch (error) {
    console.error('Create restaurant error:', error);
    res.status(500).json({ error: 'Failed to create restaurant' });
  }
});

// Update restaurant
app.patch('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const updateData = {};

    // Only allow owner to update their own restaurants
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update allowed fields
    const allowedFields = ['name', 'address', 'city', 'phone', 'email', 'cuisine', 'description'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateData.updatedAt = new Date();

    await db.collection(collections.restaurants).doc(restaurantId).update(updateData);

    res.json({ message: 'Restaurant updated successfully' });

  } catch (error) {
    console.error('Update restaurant error:', error);
    res.status(500).json({ error: 'Failed to update restaurant' });
  }
});

// Delete restaurant
app.delete('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Only allow owner to delete their own restaurants
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // TODO: Also delete associated staff, menus, orders etc.
    await db.collection(collections.restaurants).doc(restaurantId).delete();

    res.json({ message: 'Restaurant deleted successfully' });

  } catch (error) {
    console.error('Delete restaurant error:', error);
    res.status(500).json({ error: 'Failed to delete restaurant' });
  }
});

app.get('/api/menus/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { category } = req.query;

    let query = db.collection(collections.menus)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active');

    if (category) {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.get();
    const menuItems = [];

    snapshot.forEach(doc => {
      menuItems.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ menuItems });

  } catch (error) {
    console.error('Get menu error:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

app.post('/api/menus/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { 
      name, 
      description, 
      price, 
      category, 
      isVeg, 
      spiceLevel, 
      allergens,
      image,
      shortCode 
    } = req.body;

    if (!name || !price || !category) {
      return res.status(400).json({ error: 'Name, price, and category are required' });
    }

    const menuItem = {
      restaurantId,
      name,
      description: description || '',
      price: parseFloat(price),
      category,
      isVeg: isVeg || false,
      spiceLevel: spiceLevel || 'medium',
      allergens: allergens || [],
      image: image || null,
      shortCode: shortCode || name.substring(0, 3).toUpperCase(),
      status: 'active',
      order: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const menuRef = await db.collection(collections.menus).add(menuItem);

    res.status(201).json({
      message: 'Menu item created successfully',
      menuItem: {
        id: menuRef.id,
        ...menuItem
      }
    });

  } catch (error) {
    console.error('Create menu item error:', error);
    res.status(500).json({ error: 'Failed to create menu item' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { 
      restaurantId, 
      tableNumber, 
      items, 
      customerInfo, 
      orderType = 'dine-in',
      paymentMethod = 'cash',
      staffInfo,
      notes 
    } = req.body;

    if (!restaurantId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Restaurant ID and items are required' });
    }

    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await db.collection(collections.menus).doc(item.menuItemId).get();
      
      if (!menuItem.exists) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      const menuData = menuItem.data();
      const itemTotal = menuData.price * item.quantity;
      totalAmount += itemTotal;

      orderItems.push({
        menuItemId: item.menuItemId,
        name: menuData.name,
        price: menuData.price,
        quantity: item.quantity,
        total: itemTotal,
        notes: item.notes || ''
      });
    }

    const orderData = {
      restaurantId,
      tableNumber: tableNumber || null,
      orderType,
      items: orderItems,
      totalAmount,
      customerInfo: customerInfo || {},
      paymentMethod: paymentMethod || 'cash',
      staffInfo: staffInfo || null,
      notes: notes || '',
      status: 'pending',
      kotSent: false,
      paymentStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orderRef = await db.collection(collections.orders).add(orderData);

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderRef.id,
        ...orderData
      }
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, date } = req.query;

    let query = db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      
      query = query.where('createdAt', '>=', startDate)
                   .where('createdAt', '<', endDate);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    const orders = [];

    snapshot.forEach(doc => {
      orders.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ orders });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await db.collection(collections.orders).doc(orderId).update({
      status,
      updatedAt: new Date()
    });

    res.json({ message: 'Order status updated successfully' });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

app.post('/api/payments/create', async (req, res) => {
  try {
    const { orderId, amount, currency = 'INR' } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: 'Order ID and amount are required' });
    }

    // Mock payment creation for demo (Razorpay disabled)
    const mockOrder = {
      id: `mock_order_${orderId}_${Date.now()}`,
      amount: Math.round(amount * 100),
      currency,
      key: 'demo_key'
    };

    console.log(`💳 Mock payment created for order ${orderId}: ₹${amount}`);

    res.json(mockOrder);

  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.post('/api/payments/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    // Mock payment verification for demo (Razorpay disabled)
    console.log(`💳 Mock payment verification for order ${orderId}`);
    
    if (db && orderId) {
      await db.collection(collections.orders).doc(orderId).update({
        paymentStatus: 'completed',
        paymentId: razorpay_payment_id || `mock_payment_${Date.now()}`,
        updatedAt: new Date()
      });
    }

    res.json({ message: 'Payment verified successfully (mock)' });

  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.post('/api/seed-data/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const sampleMenuItems = [
      {
        name: "Butter Chicken",
        description: "Creamy tomato-based chicken curry with aromatic spices",
        price: 299,
        category: "main-course",
        isVeg: false,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "BTC",
        restaurantId,
        status: "active",
        order: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Paneer Tikka Masala",
        description: "Grilled cottage cheese cubes in rich tomato gravy",
        price: 249,
        category: "main-course",
        isVeg: true,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "PTM",
        restaurantId,
        status: "active",
        order: 2,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Biryani (Chicken)",
        description: "Fragrant basmati rice cooked with marinated chicken",
        price: 349,
        category: "rice",
        isVeg: false,
        spiceLevel: "mild",
        allergens: [],
        shortCode: "CBR",
        restaurantId,
        status: "active",
        order: 3,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Dal Tadka",
        description: "Yellow lentils tempered with cumin and garlic",
        price: 149,
        category: "dal",
        isVeg: true,
        spiceLevel: "mild",
        allergens: [],
        shortCode: "DT",
        restaurantId,
        status: "active",
        order: 4,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Garlic Naan",
        description: "Soft leavened bread topped with garlic and herbs",
        price: 89,
        category: "bread",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["gluten", "dairy"],
        shortCode: "GN",
        restaurantId,
        status: "active",
        order: 5,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Samosa (2 pcs)",
        description: "Crispy triangular pastries filled with spiced potatoes",
        price: 59,
        category: "appetizer",
        isVeg: true,
        spiceLevel: "mild",
        allergens: ["gluten"],
        shortCode: "SAM",
        restaurantId,
        status: "active",
        order: 6,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Chicken Tikka",
        description: "Grilled marinated chicken pieces with mint chutney",
        price: 199,
        category: "appetizer",
        isVeg: false,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "CT",
        restaurantId,
        status: "active",
        order: 7,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Masala Chai",
        description: "Traditional Indian spiced tea with milk",
        price: 29,
        category: "beverages",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["dairy"],
        shortCode: "MC",
        restaurantId,
        status: "active",
        order: 8,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Gulab Jamun (2 pcs)",
        description: "Soft milk dumplings in sweet cardamom syrup",
        price: 79,
        category: "dessert",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["dairy", "gluten"],
        shortCode: "GJ",
        restaurantId,
        status: "active",
        order: 9,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Fresh Lime Soda",
        description: "Refreshing lime drink with soda and mint",
        price: 49,
        category: "beverages",
        isVeg: true,
        spiceLevel: "none",
        allergens: [],
        shortCode: "FLS",
        restaurantId,
        status: "active",
        order: 10,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const batch = db.batch();
    sampleMenuItems.forEach(item => {
      const docRef = db.collection(collections.menus).doc();
      batch.set(docRef, item);
    });

    await batch.commit();

    res.json({
      message: 'Sample menu data seeded successfully',
      itemsAdded: sampleMenuItems.length
    });

  } catch (error) {
    console.error('Seed data error:', error);
    res.status(500).json({ error: 'Failed to seed sample data' });
  }
});

// Seed sample orders
app.post('/api/seed-orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const sampleOrders = [
      {
        id: `ORD-${Date.now()}-001`,
        restaurantId,
        orderType: 'dine-in',
        tableNumber: 5,
        status: 'preparing',
        customerInfo: {
          name: 'Rahul Kumar',
          phone: '+91-9876543210'
        },
        items: [
          { name: 'Butter Chicken', quantity: 2, price: 299 },
          { name: 'Garlic Naan', quantity: 3, price: 89 },
          { name: 'Basmati Rice', quantity: 1, price: 149 }
        ],
        totalAmount: 925,
        notes: 'Extra spicy',
        createdAt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-002`,
        restaurantId,
        orderType: 'delivery',
        tableNumber: null,
        status: 'delivered',
        customerInfo: {
          name: 'Priya Sharma',
          phone: '+91-9123456789',
          address: '123 MG Road, Bangalore'
        },
        items: [
          { name: 'Chicken Tikka', quantity: 1, price: 199 },
          { name: 'Fresh Lime Soda', quantity: 2, price: 49 }
        ],
        totalAmount: 297,
        notes: null,
        createdAt: new Date(Date.now() - 45 * 60 * 1000), // 45 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-003`,
        restaurantId,
        orderType: 'pickup',
        tableNumber: null,
        status: 'ready',
        customerInfo: {
          name: 'Amit Patel',
          phone: '+91-9988776655'
        },
        items: [
          { name: 'Dal Tadka', quantity: 1, price: 149 },
          { name: 'Paneer Tikka Masala', quantity: 1, price: 249 },
          { name: 'Roti', quantity: 4, price: 79 }
        ],
        totalAmount: 794,
        notes: 'Less oil please',
        createdAt: new Date(Date.now() - 25 * 60 * 1000), // 25 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-004`,
        restaurantId,
        orderType: 'dine-in',
        tableNumber: 12,
        status: 'confirmed',
        customerInfo: {
          name: 'Sunita Reddy',
          phone: '+91-8765432109'
        },
        items: [
          { name: 'Biryani (Chicken)', quantity: 1, price: 349 },
          { name: 'Samosa', quantity: 2, price: 59 },
          { name: 'Masala Chai', quantity: 1, price: 29 }
        ],
        totalAmount: 496,
        notes: null,
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        updatedAt: new Date()
      }
    ];

    // Add each order to Firestore
    const batch = db.batch();
    sampleOrders.forEach(order => {
      const orderRef = db.collection(collections.orders).doc();
      batch.set(orderRef, {
        ...order,
        id: orderRef.id // Use Firestore generated ID
      });
    });

    await batch.commit();

    res.json({
      message: 'Sample orders seeded successfully',
      ordersAdded: sampleOrders.length
    });

  } catch (error) {
    console.error('Seed orders error:', error);
    res.status(500).json({ error: 'Failed to seed sample orders' });
  }
});

// Table Management APIs
app.get('/api/tables/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .orderBy('createdAt', 'asc')
      .get();

    const tables = [];
    snapshot.forEach(doc => {
      tables.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ tables });

  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.post('/api/tables/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, floor, capacity, section } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Table name is required' });
    }

    const tableData = {
      restaurantId,
      name,
      floor: floor || 'Ground Floor',
      capacity: capacity || 4,
      section: section || 'Main',
      status: 'available', // available, occupied, reserved, cleaning
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef = await db.collection(collections.tables).add(tableData);

    res.status(201).json({
      message: 'Table created successfully',
      table: {
        id: tableRef.id,
        ...tableData
      }
    });

  } catch (error) {
    console.error('Create table error:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

app.patch('/api/tables/:tableId/status', authenticateToken, async (req, res) => {
  try {
    const { tableId } = req.params;
    const { status, orderId } = req.body;

    const validStatuses = ['available', 'occupied', 'reserved', 'cleaning'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };

    if (status === 'occupied' && orderId) {
      updateData.currentOrderId = orderId;
      updateData.lastOrderTime = new Date();
    } else if (status === 'available') {
      updateData.currentOrderId = null;
    }

    await db.collection(collections.tables).doc(tableId).update(updateData);

    res.json({ message: 'Table status updated successfully' });

  } catch (error) {
    console.error('Update table status error:', error);
    res.status(500).json({ error: 'Failed to update table status' });
  }
});

app.get('/api/analytics/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { period = '7d' } = req.query;

    const days = period === '30d' ? 30 : 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const ordersSnapshot = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startDate)
      .get();

    let totalRevenue = 0;
    let totalOrders = 0;
    const dailyStats = {};

    ordersSnapshot.forEach(doc => {
      const order = doc.data();
      const date = order.createdAt.toDate().toDateString();

      totalOrders++;
      totalRevenue += order.totalAmount;

      if (!dailyStats[date]) {
        dailyStats[date] = { orders: 0, revenue: 0 };
      }
      dailyStats[date].orders++;
      dailyStats[date].revenue += order.totalAmount;
    });

    res.json({
      period,
      totalRevenue,
      totalOrders,
      averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      dailyStats
    });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Staff Management APIs
const requireOwnerRole = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Access denied. Owner role required.' });
  }
  next();
};

// Get all staff for a restaurant
app.get('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.users)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['waiter', 'manager'])
      .get();

    const staff = [];
    snapshot.forEach(doc => {
      const userData = doc.data();
      staff.push({
        id: doc.id,
        name: userData.name,
        phone: userData.phone,
        email: userData.email,
        role: userData.role,
        status: userData.status || 'active',
        startDate: userData.startDate,
        lastLogin: userData.lastLogin,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt
      });
    });

    res.json({ staff });

  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// Add new staff member
app.post('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, phone, email, role = 'waiter', startDate, address } = req.body;

    if (!name || !phone || !email) {
      return res.status(400).json({ error: 'Name, phone, and email are required' });
    }

    // Check if email already exists
    const existingUser = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Generate random password for staff
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    const staffData = {
      name,
      phone,
      email,
      password: hashedPassword,
      role,
      restaurantId,
      address: address || null,
      status: 'active',
      startDate: startDate ? new Date(startDate) : new Date(),
      phoneVerified: false,
      emailVerified: false,
      provider: 'staff',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLogin: null,
      temporaryPassword: true // Flag to indicate password needs to be changed
    };

    const staffRef = await db.collection(collections.users).add(staffData);

    // TODO: Send email with login credentials
    console.log(`📧 Staff Login Credentials for ${name}:`);
    console.log(`   Login ID: ${email}`);
    console.log(`   Password: ${temporaryPassword}`);
    console.log(`   Restaurant: ${restaurantId}`);

    res.status(201).json({
      message: 'Staff member added successfully. Login credentials sent to email.',
      staff: {
        id: staffRef.id,
        name,
        phone,
        email,
        role,
        restaurantId,
        address,
        status: 'active',
        startDate: staffData.startDate,
        createdAt: staffData.createdAt
      },
      // For demo purposes, return credentials (remove in production)
      credentials: {
        loginId: email,
        password: temporaryPassword
      }
    });

  } catch (error) {
    console.error('Add staff error:', error);
    res.status(500).json({ error: 'Failed to add staff member' });
  }
});

// Update staff member
app.patch('/api/staff/:staffId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { name, phone, email, role, status } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (role) updateData.role = role;
    if (status) updateData.status = status;

    await db.collection(collections.users).doc(staffId).update(updateData);

    res.json({ message: 'Staff member updated successfully' });

  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

// Delete staff member
app.delete('/api/staff/:staffId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;

    await db.collection(collections.users).doc(staffId).delete();

    res.json({ message: 'Staff member deleted successfully' });

  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// Staff login with email and password
app.post('/api/auth/staff/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Login ID and password are required' });
    }

    // Find staff member by loginId (email)
    const staffQuery = await db.collection(collections.users)
      .where('email', '==', loginId)
      .where('role', 'in', ['waiter', 'manager'])
      .where('status', '==', 'active')
      .get();

    if (staffQuery.empty) {
      return res.status(404).json({ error: 'Staff member not found or inactive' });
    }

    const staffDoc = staffQuery.docs[0];
    const staffData = staffDoc.data();

    // Check password
    const isValidPassword = await bcrypt.compare(password, staffData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await staffDoc.ref.update({
      lastLogin: new Date(),
      updatedAt: new Date()
    });

    const token = jwt.sign(
      { 
        userId: staffDoc.id, 
        email: staffData.email, 
        role: staffData.role,
        restaurantId: staffData.restaurantId
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Staff login successful',
      token,
      user: {
        id: staffDoc.id,
        email: staffData.email,
        name: staffData.name,
        role: staffData.role,
        restaurantId: staffData.restaurantId,
        phone: staffData.phone
      }
    });

  } catch (error) {
    console.error('Staff login error:', error);
    res.status(500).json({ error: 'Staff login failed' });
  }
});

app.use((err, req, res, next) => {
  console.error(`[${req.id}] Error:`, err);
  
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  res.status(err.status || 500).json({ 
    error: 'Internal Server Error',
    message: isDevelopment ? err.message : 'Something went wrong',
    requestId: req.id,
    ...(isDevelopment && { stack: err.stack })
  });
});

// 404 handler - must be last
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: `Endpoint ${req.originalUrl} not found`,
    requestId: req.id,
    available_endpoints: [
      '/',
      '/health', 
      '/api/auth/*',
      '/api/restaurants/*',
      '/api/menus/*',
      '/api/orders/*',
      '/api/payments/*',
      '/api/analytics/*'
    ]
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dine Backend server running on port ${PORT}`);
    console.log(`🌐 Local URL: http://localhost:${PORT}`);
    console.log(`🍽️ Ready to serve your restaurant management app!`);
  });
}

module.exports = app;