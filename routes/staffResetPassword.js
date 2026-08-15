const express = require('express');
const bcrypt = require('bcryptjs');
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');

const router = express.Router();

// Validate and normalize optional username; returns { username, usernameLower } or null. On error sets res and returns null.
function parseUsername(input, res) {
  if (input == null || String(input).trim() === '') return null;
  const raw = String(input).trim();
  if (raw.length < 3 || raw.length > 50) {
    res.status(400).json({ error: 'Username must be 3–50 characters' });
    return null;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
    res.status(400).json({ error: 'Username can only contain letters, numbers and underscore' });
    return null;
  }
  return { username: raw, usernameLower: raw.toLowerCase() };
}

// Reset staff password (owner only): generate temporary password OR set new password (password + confirm). Optional username.
router.post('/:staffId/reset-password', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { newPassword, confirmPassword, username: usernameInput } = req.body;

    // Check staffUsers first, fall back to users
    let staffDoc = await db.collection(collections.staffUsers).doc(staffId).get();
    if (!staffDoc.exists) {
      staffDoc = await db.collection(collections.users).doc(staffId).get();
    }
    if (!staffDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const staffData = staffDoc.data();
    // Any staff member can have their password reset — including CUSTOM roles. Only block the
    // account owner and customers (a whitelist can never cover arbitrary custom role names).
    const blockedRoles = ['owner', 'customer', 'super-admin', 'sub-admin'];
    if (blockedRoles.includes((staffData.role || '').toLowerCase())) {
      return res.status(400).json({ error: 'Only staff members can have password reset' });
    }
    // If the staff has no login ID (legacy / custom-role staff created without one), generate a
    // unique 5-digit login ID now — resetting the password should also provision it, since they
    // need it to log in. Matches the staff-create generation.
    let loginId = staffData.loginId;
    if (!loginId) {
      let isUnique = false;
      while (!isUnique) {
        loginId = Math.floor(10000 + Math.random() * 90000).toString();
        const inStaff = await db.collection(collections.staffUsers).where('loginId', '==', loginId).limit(1).get();
        const inUsers = await db.collection(collections.users).where('loginId', '==', loginId).limit(1).get();
        isUnique = inStaff.empty && inUsers.empty;
      }
    }

    // Optional username: validate and check uniqueness (case-insensitive, exclude current user)
    let usernameUpdate = null;
    const parsed = parseUsername(usernameInput, res);
    if (parsed === null && usernameInput != null && String(usernameInput).trim() !== '') return; // parseUsername already sent error
    if (parsed) {
      // Check username uniqueness in both collections
      const existingInStaff = await db.collection(collections.staffUsers)
        .where('usernameLower', '==', parsed.usernameLower).get();
      const existingInUsers = await db.collection(collections.users)
        .where('usernameLower', '==', parsed.usernameLower).get();
      const allDocs = [...existingInStaff.docs, ...existingInUsers.docs];
      const takenByOther = allDocs.some(doc => doc.id !== staffId);
      if (takenByOther) {
        return res.status(400).json({ error: 'Username already exists. Choose a different username.' });
      }
      usernameUpdate = { username: parsed.username, usernameLower: parsed.usernameLower };
    }

    const baseUpdate = {
      ...(usernameUpdate || {}),
      ...(staffData.loginId ? {} : { loginId }), // persist the newly generated login ID
      updatedAt: new Date()
    };

    if (newPassword != null && confirmPassword != null) {
      // Set new password (admin-defined)
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'Password and confirmation do not match' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await staffDoc.ref.update({
        password: hashedPassword,
        temporaryPassword: false,
        ...baseUpdate
      });
      try {
        await db.collection('staffCredentials').doc(staffId).delete();
      } catch (e) {
        // ignore
      }
      return res.json({
        success: true,
        message: 'Password set successfully. Staff can log in with the new password.',
        loginId: loginId,
        username: usernameUpdate ? usernameUpdate.username : (staffData.username || null)
      });
    }

    // Generate temporary password
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    await staffDoc.ref.update({
      password: hashedPassword,
      temporaryPassword: true,
      ...baseUpdate
    });
    await db.collection('staffCredentials').doc(staffId).set({
      staffId,
      loginId: loginId,
      temporaryPassword,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    const finalUsername = usernameUpdate ? usernameUpdate.username : (staffData.username || null);
    return res.json({
      success: true,
      message: 'Temporary password generated. Share with staff; they should change it in the app.',
      loginId: loginId,
      username: finalUsername,
      temporaryPassword
    });
  } catch (error) {
    console.error('Reset staff password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
