const { db, collections } = require('../firebase');
const crypto = require('crypto');

/**
 * Discount Approval Service
 * Handles PIN and OTP-based approval for discounts
 */

// Generate unique ID
function genId(prefix = 'da') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  return { code, hash, expiresAt };
}

/**
 * Verify OTP against hash
 */
function verifyOTPHash(code, hash) {
  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  return inputHash === hash;
}

/**
 * Hash a PIN for comparison
 */
function hashPIN(pin) {
  return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}

/**
 * Mask phone/email for display
 */
function maskContact(contact) {
  if (!contact) return '';
  if (contact.includes('@')) {
    const [user, domain] = contact.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  // Phone: show last 4 digits
  return `****${contact.slice(-4)}`;
}

/**
 * Get approver contacts (owner/manager phone & email)
 */
async function getApproverContacts(restaurantId, approverRole) {
  // Find users with the approver role for this restaurant
  const userRestSnap = await db.collection(collections.userRestaurants)
    .where('restaurantId', '==', restaurantId)
    .where('role', 'in', approverRole === 'owner' ? ['owner'] : ['owner', 'manager'])
    .limit(5)
    .get();

  if (userRestSnap.empty) return [];

  const contacts = [];
  for (const doc of userRestSnap.docs) {
    const ur = doc.data();
    // Look up user details
    const userSnap = await db.collection(collections.users).doc(ur.userId).get();
    if (userSnap.exists) {
      const user = userSnap.data();
      contacts.push({
        userId: ur.userId,
        name: user.name || user.displayName || 'Manager',
        phone: user.phone || user.phoneNumber || null,
        email: user.email || null,
        role: ur.role,
        pinHash: user.pinHash || null  // stored PIN hash for PIN verification
      });
    }
  }

  return contacts;
}

/**
 * Send OTP via WhatsApp
 */
async function sendOTPWhatsApp(restaurantId, phone, code) {
  try {
    // Lazy-load WhatsApp service to avoid circular deps
    const WhatsAppService = require('./whatsappService');
    const whatsapp = new WhatsAppService();

    // Get restaurant WhatsApp credentials
    const restDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restDoc.exists) throw new Error('Restaurant not found');
    const restData = restDoc.data();

    if (restData.whatsappCredentials) {
      await whatsapp.initialize(restaurantId, restData.whatsappCredentials);
    }

    const message = `DineOpen Discount Approval\n\nYour OTP is: ${code}\n\nThis code expires in 5 minutes. Share it with your staff to authorize the discount.`;
    return await whatsapp.sendTextMessage(phone, message);
  } catch (error) {
    console.error('Failed to send OTP via WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send OTP via Email
 */
async function sendOTPEmail(restaurantId, email, code) {
  try {
    const EmailService = require('../emailService');
    const emailService = new EmailService();

    await emailService.transporter.sendMail({
      from: `"DineOpen" <${process.env.GODADY_EMAIL}>`,
      to: email,
      subject: 'Discount Approval OTP',
      text: `Your DineOpen discount approval OTP is: ${code}\n\nThis code expires in 5 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #DC4A3A;">Discount Approval OTP</h2>
          <p>Your verification code is:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 16px; background: #f5f5f5; border-radius: 8px; text-align: center; margin: 16px 0;">
            ${code}
          </div>
          <p style="color: #666;">This code expires in 5 minutes.</p>
          <p style="color: #999; font-size: 12px;">If you didn't request this, please ignore this email.</p>
        </div>
      `
    });

    return { success: true };
  } catch (error) {
    console.error('Failed to send OTP via email:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Request discount approval
 * Returns approvalId and method info for the client to show the right UI
 */
async function requestApproval(restaurantId, data) {
  const id = genId('da');
  const now = new Date();

  // Look up approval settings from restaurant settings
  const settingsSnap = await db.collection(collections.restaurantSettings)
    .where('restaurantId', '==', restaurantId)
    .limit(1)
    .get();

  let settings = {};
  if (!settingsSnap.empty) {
    settings = settingsSnap.docs[0].data().discountApprovalSettings || {};
  }

  if (!settings.enabled) {
    return { approved: true, method: 'none', message: 'Approval not required' };
  }

  const roleConfig = settings.roleConfig?.[data.requestedByRole];
  if (!roleConfig || !roleConfig.requireApproval) {
    return { approved: true, method: 'none', message: 'Approval not required for this role' };
  }

  // Check threshold
  const discountAmount = Number(data.discountAmount) || 0;
  if (roleConfig.maxDiscountWithoutApproval > 0 && discountAmount <= roleConfig.maxDiscountWithoutApproval) {
    return { approved: true, method: 'none', message: 'Discount within auto-approval threshold' };
  }

  const approverRole = roleConfig.approverRole || 'manager';
  const approvalMethod = roleConfig.approvalMethod || 'pin';
  const otpChannel = roleConfig.otpChannel || 'whatsapp';

  const approval = {
    id,
    restaurantId,
    orderId: data.orderId || null,
    requestedBy: data.requestedBy,
    requestedByName: data.requestedByName || '',
    requestedByRole: data.requestedByRole,
    approvedBy: null,
    approvedByName: null,
    approvalMethod,
    otpChannel: approvalMethod === 'otp' ? otpChannel : null,
    discountType: data.discountType || 'percentage',
    discountValue: Number(data.discountValue) || 0,
    discountAmount,
    subtotal: Number(data.subtotal) || 0,
    status: 'pending',
    otpCode: null,
    otpSentTo: null,
    otpExpiresAt: null,
    createdAt: now,
    resolvedAt: null
  };

  // If OTP method, generate and send OTP
  if (approvalMethod === 'otp') {
    const contacts = await getApproverContacts(restaurantId, approverRole);
    if (contacts.length === 0) {
      throw new Error('No approver contacts found. Please configure manager/owner contact details.');
    }

    const { code, hash, expiresAt } = generateOTP();
    approval.otpCode = hash;
    approval.otpExpiresAt = expiresAt;

    // Send OTP to first available contact
    const contact = contacts[0];
    let sentTo = null;

    if (otpChannel === 'whatsapp' || otpChannel === 'both') {
      if (contact.phone) {
        await sendOTPWhatsApp(restaurantId, contact.phone, code);
        sentTo = contact.phone;
      }
    }
    if (otpChannel === 'email' || otpChannel === 'both') {
      if (contact.email) {
        await sendOTPEmail(restaurantId, contact.email, code);
        sentTo = sentTo || contact.email;
      }
    }

    approval.otpSentTo = maskContact(sentTo);
  }

  await db.collection('discountApprovals').doc(id).set(approval);

  return {
    approved: false,
    approvalId: id,
    method: approvalMethod,
    otpChannel: approval.otpChannel,
    sentTo: approval.otpSentTo,
    expiresAt: approval.otpExpiresAt
  };
}

/**
 * Verify approval (PIN or OTP)
 */
async function verifyApproval(approvalId, verificationData) {
  const ref = db.collection('discountApprovals').doc(approvalId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Approval request not found');

  const approval = doc.data();

  if (approval.status !== 'pending') {
    throw new Error(`Approval already ${approval.status}`);
  }

  const now = new Date();

  if (approval.approvalMethod === 'otp') {
    // Check expiry
    const expiresAt = approval.otpExpiresAt?.toDate ? approval.otpExpiresAt.toDate() : new Date(approval.otpExpiresAt);
    if (now > expiresAt) {
      await ref.update({ status: 'expired', resolvedAt: now });
      throw new Error('OTP has expired. Please request a new one.');
    }

    // Verify OTP
    if (!verificationData.otp || !verifyOTPHash(verificationData.otp, approval.otpCode)) {
      return { approved: false, message: 'Invalid OTP' };
    }

    await ref.update({
      status: 'approved',
      approvedBy: 'otp-verified',
      approvedByName: 'OTP Verification',
      resolvedAt: now
    });

    return { approved: true, approvalId };
  }

  if (approval.approvalMethod === 'pin') {
    if (!verificationData.pin) {
      return { approved: false, message: 'PIN is required' };
    }

    // Get approver contacts to check PIN
    const approverRole = approval.approverRole || 'manager';
    const contacts = await getApproverContacts(approval.restaurantId, approverRole);
    const pinHash = hashPIN(verificationData.pin);

    // Check if any approver's PIN matches
    const matchedApprover = contacts.find(c => c.pinHash && c.pinHash === pinHash);

    if (!matchedApprover) {
      return { approved: false, message: 'Invalid PIN' };
    }

    await ref.update({
      status: 'approved',
      approvedBy: matchedApprover.userId,
      approvedByName: matchedApprover.name,
      resolvedAt: now
    });

    return { approved: true, approvalId, approvedBy: matchedApprover.name };
  }

  throw new Error('Unknown approval method');
}

/**
 * Get approval history
 */
async function getApprovalHistory(restaurantId, { limit: queryLimit = 50 } = {}) {
  const snap = await db.collection('discountApprovals')
    .where('restaurantId', '==', restaurantId)
    .orderBy('createdAt', 'desc')
    .limit(queryLimit)
    .get();
  return snap.docs.map(d => {
    const data = d.data();
    // Never expose OTP hash
    delete data.otpCode;
    return data;
  });
}

module.exports = {
  generateOTP,
  hashPIN,
  requestApproval,
  verifyApproval,
  getApproverContacts,
  getApprovalHistory,
  sendOTPWhatsApp,
  sendOTPEmail
};
