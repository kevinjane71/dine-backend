const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (db, collections) => {
  const router = express.Router();

  async function getOrgId(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  }

  const DEFAULT_SETTINGS = {
    invoiceNumberPrefix: 'INV-',
    invoiceStartNumber: 1,
    quoteNumberPrefix: 'QT-',
    challanNumberPrefix: 'DC-',
    paymentNumberPrefix: 'PAY-',
    defaultPaymentTerms: 'due_on_receipt',
    defaultCustomerNotes: 'Thanks for your business.',
    defaultTermsAndConditions: '',
    taxSettings: {
      enabled: true,
      defaultRate: 18,
      type: 'GST'
    },
    pdfTemplate: 'standard',
    pdfColors: {
      background: '#DC2626',
      label: '#4CAF50',
      font: '#1565C0'
    }
  };

  // GET / — Get settings for org (create defaults if none)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const snapshot = await db.collection(collections.invSettings)
        .where('orgId', '==', orgId)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        return res.json({
          success: true,
          data: { id: doc.id, ...doc.data() }
        });
      }

      // Create default settings
      const settingsData = {
        orgId,
        ...DEFAULT_SETTINGS,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invSettings).add(settingsData);

      return res.json({
        success: true,
        data: { id: docRef.id, ...settingsData }
      });
    } catch (error) {
      console.error('Error getting settings:', error);
      return res.status(500).json({ success: false, error: 'Failed to get settings' });
    }
  });

  // PATCH / — Update settings
  router.patch('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let snapshot = await db.collection(collections.invSettings)
        .where('orgId', '==', orgId)
        .limit(1)
        .get();

      // Create default settings if they don't exist yet
      if (snapshot.empty) {
        const settingsData = {
          orgId,
          ...DEFAULT_SETTINGS,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };
        await db.collection(collections.invSettings).add(settingsData);

        snapshot = await db.collection(collections.invSettings)
          .where('orgId', '==', orgId)
          .limit(1)
          .get();
      }

      const doc = snapshot.docs[0];

      const allowedFields = [
        'invoiceNumberPrefix', 'invoiceStartNumber',
        'quoteNumberPrefix', 'challanNumberPrefix', 'paymentNumberPrefix',
        'defaultPaymentTerms', 'defaultCustomerNotes', 'defaultTermsAndConditions',
        'taxSettings', 'pdfTemplate', 'pdfColors'
      ];

      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          if (field === 'invoiceStartNumber') {
            updateData[field] = parseInt(req.body[field]) || 1;
          } else {
            updateData[field] = req.body[field];
          }
        }
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invSettings).doc(doc.id).update(updateData);

      // If number prefixes changed, update the number sequences too
      const prefixMapping = {
        invoiceNumberPrefix: 'invoice',
        quoteNumberPrefix: 'quote',
        challanNumberPrefix: 'challan',
        paymentNumberPrefix: 'payment'
      };

      for (const [settingField, seqType] of Object.entries(prefixMapping)) {
        if (updateData[settingField]) {
          const seqDocId = `${orgId}_${seqType}`;
          const seqRef = db.collection(collections.invNumberSequences).doc(seqDocId);
          const seqDoc = await seqRef.get();
          if (seqDoc.exists) {
            await seqRef.update({
              prefix: updateData[settingField],
              updatedAt: FieldValue.serverTimestamp()
            });
          }
        }
      }

      const updated = await db.collection(collections.invSettings).doc(doc.id).get();

      return res.json({
        success: true,
        data: { id: doc.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating settings:', error);
      return res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
  });

  return router;
};
