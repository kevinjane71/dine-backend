const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const bcrypt = require('bcryptjs');

// Role-based default page access (same as index.js)
const ROLE_DEFAULT_PAGE_ACCESS = {
  admin:    { dashboard:true, history:true, tables:true, menu:true, analytics:true, inventory:true, kot:true, admin:{ settings:true, tax:true, pricing:true, payments:true, billingSettings:true, currency:true, print:true, features:true, restaurants:true, staff:true, orderManagement:true, offers:true, loyalty:true, googleReviews:true, whatsapp:true }, completeBill:true, invoice:true, customers:true, offers:true, printer:true },
  manager:  { dashboard:true, history:true, tables:true, menu:true, analytics:true, inventory:{ read:true, add:true, update:true, delete:false }, kot:true, admin:false, completeBill:true, invoice:true, customers:true, offers:true, printer:true },
  captain:  { dashboard:true, history:true, tables:{ read:true, add:false, update:true, delete:false, reset:true }, menu:true, analytics:false, inventory:false, kot:true, admin:false, completeBill:true, invoice:false, customers:false, offers:false, printer:true, orders:{ read:true, update:true, cancel:true, refund:true, completeBill:true } },
  waiter:   { dashboard:true, history:true, tables:{ read:true, add:false, update:true, delete:false, reset:false }, menu:true, analytics:false, inventory:false, kot:false, admin:false, completeBill:false, invoice:false, customers:false, offers:false, printer:true },
  cashier:  { dashboard:true, history:true, tables:false, menu:true, analytics:false, inventory:false, kot:false, admin:false, completeBill:true, invoice:true, customers:false, offers:false, printer:true },
  employee: { dashboard:true, history:true, tables:{ read:true, add:false, update:false, delete:false, reset:false }, menu:true, analytics:false, inventory:false, kot:false, admin:false, completeBill:false, invoice:false, customers:false, offers:false, printer:true },
  sales:    { dashboard:true, history:true, tables:false, menu:true, analytics:false, inventory:false, kot:false, admin:false, completeBill:false, invoice:false, customers:true, offers:true, printer:true },
};

const VALID_ROLES = ['admin', 'manager', 'captain', 'waiter', 'cashier', 'employee', 'sales', 'kitchen', 'delivery'];

// Generate unique 5-digit login ID (checks both staffUsers and users collections)
async function generateUniqueLoginId() {
  let userId;
  let isUnique = false;
  let attempts = 0;
  while (!isUnique && attempts < 100) {
    userId = Math.floor(10000 + Math.random() * 90000).toString();
    const [existInStaff, existInUsers] = await Promise.all([
      db.collection(collections.staffUsers).where('loginId', '==', userId).limit(1).get(),
      db.collection(collections.users).where('loginId', '==', userId).limit(1).get(),
    ]);
    isUnique = existInStaff.empty && existInUsers.empty;
    attempts++;
  }
  if (!isUnique) throw new Error('Failed to generate unique login ID after 100 attempts');
  return userId;
}

// Try to parse structured CSV for staff data
function tryParseStructuredStaffCSV(buffer, fileName) {
  try {
    const XLSX = require('xlsx');
    const ext = (fileName || '').split('.').pop().toLowerCase();
    const isCSV = ext === 'csv' || ext === 'tsv' || ext === 'txt';
    const workbook = isCSV
      ? XLSX.read(buffer.toString('utf-8').replace(/^\uFEFF/, ''), { type: 'string' })
      : XLSX.read(buffer, { type: 'buffer', codepage: 65001 });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows || rows.length === 0) return null;

    const headers = Object.keys(rows[0]).map(h => h.toLowerCase().trim());
    const origHeaders = Object.keys(rows[0]);
    const findOrig = (lc) => origHeaders.find(h => h.toLowerCase().trim() === lc);

    // Detect known column patterns
    const nameCol = headers.find(h => /^(name|staff_?name|employee_?name|full_?name)$/i.test(h));
    const phoneCol = headers.find(h => /^(phone|mobile|phone_?number|mobile_?number|contact)$/i.test(h));
    if (!nameCol) return null; // Name is required

    const nameKey = findOrig(nameCol);
    const phoneKey = phoneCol ? findOrig(phoneCol) : null;
    const roleCol = headers.find(h => /^(role|designation|position|job_?title)$/i.test(h));
    const roleKey = roleCol ? findOrig(roleCol) : null;
    const salaryCol = headers.find(h => /^(salary|pay|wage|monthly_?salary|ctc)$/i.test(h));
    const salaryKey = salaryCol ? findOrig(salaryCol) : null;
    const emailCol = headers.find(h => /^(email|email_?id|e-?mail)$/i.test(h));
    const emailKey = emailCol ? findOrig(emailCol) : null;
    const addressCol = headers.find(h => /^(address|addr|location)$/i.test(h));
    const addressKey = addressCol ? findOrig(addressCol) : null;
    const aadharCol = headers.find(h => /^(aadhar|aadhaar|aadhar_?number|id_?number|national_?id)$/i.test(h));
    const aadharKey = aadharCol ? findOrig(aadharCol) : null;

    console.log(`📊 Structured staff CSV detected: ${rows.length} rows, name="${nameKey}", phone="${phoneKey || 'none'}", role="${roleKey || 'none'}"`);

    const staff = [];
    const seenPhones = new Set();

    for (const row of rows) {
      const name = String(row[nameKey] || '').trim();
      if (!name) continue;

      const phone = phoneKey ? String(row[phoneKey] || '').replace(/[^0-9+]/g, '').trim() : '';
      const roleRaw = roleKey ? String(row[roleKey] || '').toLowerCase().trim() : 'waiter';
      const role = VALID_ROLES.includes(roleRaw) ? roleRaw : 'waiter';
      const salary = salaryKey ? (parseFloat(row[salaryKey]) || 0) : 0;
      const email = emailKey ? String(row[emailKey] || '').trim() : '';
      const address = addressKey ? String(row[addressKey] || '').trim() : '';
      const aadhar = aadharKey ? String(row[aadharKey] || '').trim() : '';

      // Deduplicate by phone
      if (phone && seenPhones.has(phone)) continue;
      if (phone) seenPhones.add(phone);

      staff.push({ name, phone, role, salary, email, address, aadhar });
    }

    console.log(`✅ Structured staff CSV parsed: ${staff.length} staff members`);
    return staff;
  } catch (err) {
    console.log('⚠️ Structured staff CSV parse failed:', err.message);
    return null;
  }
}

// ── Extract staff from CSV/image/text ────────────────────────────────
router.post('/:restaurantId/extract', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

    // Handle multipart upload
    upload.single('file')(req, res, async (uploadErr) => {
      try {
        if (uploadErr) {
          return res.status(400).json({ error: 'File upload failed: ' + uploadErr.message });
        }

        let staffData = null;
        let source = 'csv';

        // Case 1: File uploaded (CSV or image)
        if (req.file) {
          const { buffer, originalname, mimetype } = req.file;
          const isImage = mimetype && mimetype.startsWith('image/');

          if (!isImage) {
            // Try structured CSV parsing first (no AI cost)
            staffData = tryParseStructuredStaffCSV(buffer, originalname);
          }

          if (!staffData) {
            // Fallback: AI extraction (for images or unstructured files)
            source = 'ai';
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const messages = [{
              role: 'user',
              content: isImage
                ? [
                    { type: 'text', text: `Extract staff/employee details from this image. Return a JSON array where each object has: name (string, required), phone (string), role (one of: ${VALID_ROLES.join(', ')}; default "waiter"), salary (number, 0 if unknown), email (string), address (string), aadhar (string). Only include people who appear to be staff/employees. Return ONLY the JSON array, no explanation.` },
                    { type: 'image_url', image_url: { url: `data:${mimetype};base64,${buffer.toString('base64')}` } }
                  ]
                : [
                    { type: 'text', text: `Parse this file content into staff/employee records. Return a JSON array where each object has: name (string, required), phone (string), role (one of: ${VALID_ROLES.join(', ')}; default "waiter"), salary (number, 0 if unknown), email (string), address (string), aadhar (string). Return ONLY the JSON array, no explanation.\n\nContent:\n${buffer.toString('utf-8').slice(0, 10000)}` }
                  ]
            }];

            const completion = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages,
              max_tokens: 4000,
              temperature: 0.1,
            });

            const responseText = completion.choices[0]?.message?.content || '[]';
            // Extract JSON from response (handle markdown code blocks)
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            staffData = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
          }
        }
        // Case 2: Text paste (JSON body)
        else if (req.body && req.body.text) {
          source = 'ai';
          const OpenAI = require('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
              role: 'user',
              content: `Parse this text into staff/employee records. Return a JSON array where each object has: name (string, required), phone (string), role (one of: ${VALID_ROLES.join(', ')}; default "waiter"), salary (number, 0 if unknown), email (string), address (string), aadhar (string). Return ONLY the JSON array, no explanation.\n\nText:\n${String(req.body.text).slice(0, 10000)}`
            }],
            max_tokens: 4000,
            temperature: 0.1,
          });

          const responseText = completion.choices[0]?.message?.content || '[]';
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          staffData = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        }
        else {
          return res.status(400).json({ error: 'No file or text provided' });
        }

        // Normalize and validate
        const staff = (Array.isArray(staffData) ? staffData : []).map(s => ({
          name: String(s.name || '').trim(),
          phone: String(s.phone || '').replace(/[^0-9+]/g, '').trim(),
          role: VALID_ROLES.includes(String(s.role || '').toLowerCase()) ? String(s.role).toLowerCase() : 'waiter',
          salary: parseFloat(s.salary) || 0,
          email: String(s.email || '').trim(),
          address: String(s.address || '').trim(),
          aadhar: String(s.aadhar || '').trim(),
        })).filter(s => s.name); // Remove entries without name

        // Deduplicate by phone
        const seenPhones = new Set();
        const deduped = staff.filter(s => {
          if (!s.phone) return true;
          if (seenPhones.has(s.phone)) return false;
          seenPhones.add(s.phone);
          return true;
        });

        res.json({ staff: deduped, source, count: deduped.length });
      } catch (innerErr) {
        console.error('Bulk staff extract inner error:', innerErr);
        res.status(500).json({ error: 'Failed to extract staff data: ' + innerErr.message });
      }
    });
  } catch (error) {
    console.error('Bulk staff extract error:', error);
    res.status(500).json({ error: 'Failed to extract staff data' });
  }
});

// ── Batch create staff ───────────────────────────────────────────────
router.post('/:restaurantId/save', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staff } = req.body;

    if (!Array.isArray(staff) || staff.length === 0) {
      return res.status(400).json({ error: 'Staff array is required and must not be empty' });
    }

    if (staff.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 staff members can be created at once' });
    }

    // Only owner can create admin staff
    const hasAdminRole = staff.some(s => s.role === 'admin');
    if (hasAdminRole && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the account owner can create admin staff.' });
    }

    // Cannot create owner role via bulk API
    if (staff.some(s => s.role === 'owner')) {
      return res.status(400).json({ error: 'Cannot create owner role via staff API.' });
    }

    // Check for duplicate phones within the batch
    const phones = staff.map(s => s.phone).filter(Boolean);
    const uniquePhones = new Set(phones);
    if (phones.length !== uniquePhones.size) {
      return res.status(400).json({ error: 'Duplicate phone numbers found in the batch' });
    }

    // Check existing phone numbers in Firestore
    if (phones.length > 0) {
      // Firestore 'in' queries support max 30 items, chunk if needed
      const phoneChunks = [];
      for (let i = 0; i < phones.length; i += 30) {
        phoneChunks.push(phones.slice(i, i + 30));
      }
      for (const chunk of phoneChunks) {
        const existing = await db.collection(collections.staffUsers)
          .where('phone', 'in', chunk)
          .where('restaurantId', '==', restaurantId)
          .limit(1).get();
        if (!existing.empty) {
          const existingPhone = existing.docs[0].data().phone;
          return res.status(400).json({ error: `Phone number ${existingPhone} already exists for a staff member in this restaurant` });
        }
      }
    }

    const created = [];
    const now = new Date();

    // Process each staff member (sequential for loginId uniqueness)
    for (const s of staff) {
      const name = String(s.name || '').trim();
      const phone = String(s.phone || '').replace(/[^0-9+]/g, '').trim();
      const email = String(s.email || '').trim() || null;
      const role = VALID_ROLES.includes(String(s.role || '').toLowerCase()) ? String(s.role).toLowerCase() : 'waiter';
      const salary = parseFloat(s.salary) || 0;
      const address = String(s.address || '').trim() || null;
      const aadhar = String(s.aadhar || '').trim() || null;

      if (!name) continue;

      // Generate unique login ID
      const loginId = await generateUniqueLoginId();

      // Generate random password
      const temporaryPassword = Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

      const staffData = {
        name,
        phone,
        email,
        password: hashedPassword,
        role,
        restaurantId,
        address,
        aadhar,
        salary,
        status: 'active',
        startDate: now,
        phoneVerified: false,
        emailVerified: false,
        provider: 'staff',
        createdAt: now,
        updatedAt: now,
        lastLogin: null,
        temporaryPassword: true,
        loginId,
        pageAccess: ROLE_DEFAULT_PAGE_ACCESS[role] || {
          dashboard: true, history: true, tables: true, menu: true,
          analytics: false, inventory: false, kot: false, admin: false, completeBill: false
        },
      };

      // Use batch for the 3 writes per staff member
      const batch = db.batch();

      const staffRef = db.collection(collections.staffUsers).doc();
      batch.set(staffRef, staffData);

      const urRef = db.collection(collections.userRestaurants).doc();
      batch.set(urRef, {
        userId: staffRef.id,
        restaurantId,
        role,
        pageAccess: staffData.pageAccess,
        createdAt: now,
        updatedAt: now,
      });

      const credRef = db.collection('staffCredentials').doc(staffRef.id);
      batch.set(credRef, {
        staffId: staffRef.id,
        loginId,
        temporaryPassword,
        createdAt: now,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      await batch.commit();

      created.push({
        id: staffRef.id,
        name,
        phone,
        email,
        role,
        loginId,
        tempPassword: temporaryPassword,
      });

      console.log(`📧 Bulk Staff Created: ${name} (${loginId}) → ${restaurantId}`);
    }

    res.status(201).json({
      message: `${created.length} staff members created successfully`,
      created,
      count: created.length,
    });
  } catch (error) {
    console.error('Bulk staff save error:', error);
    res.status(500).json({ error: 'Failed to create staff members: ' + error.message });
  }
});

module.exports = router;
