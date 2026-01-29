const express = require('express');
const bcrypt = require('bcryptjs');
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');

const router = express.Router();

// Reset staff password (owner only): generate temporary password OR set new password (password + confirm)
router.post('/:staffId/reset-password', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { newPassword, confirmPassword } = req.body;

    const staffDoc = await db.collection(collections.users).doc(staffId).get();
    if (!staffDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const staffData = staffDoc.data();
    const staffRoles = ['waiter', 'manager', 'employee', 'cashier', 'sales'];
    if (!staffRoles.includes((staffData.role || '').toLowerCase())) {
      return res.status(400).json({ error: 'Only staff members can have password reset' });
    }
    if (!staffData.loginId) {
      return res.status(400).json({ error: 'Staff has no login ID' });
    }

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
        updatedAt: new Date()
      });
      try {
        await db.collection('staffCredentials').doc(staffId).delete();
      } catch (e) {
        // ignore
      }
      return res.json({
        success: true,
        message: 'Password set successfully. Staff can log in with the new password.'
      });
    }

    // Generate temporary password
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    await staffDoc.ref.update({
      password: hashedPassword,
      temporaryPassword: true,
      updatedAt: new Date()
    });
    await db.collection('staffCredentials').doc(staffId).set({
      staffId,
      loginId: staffData.loginId,
      temporaryPassword,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    return res.json({
      success: true,
      message: 'Temporary password generated. Share with staff; they should change it in the app.',
      loginId: staffData.loginId,
      temporaryPassword
    });
  } catch (error) {
    console.error('Reset staff password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
