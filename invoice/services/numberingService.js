const { FieldValue } = require('firebase-admin/firestore');

const PREFIXES = {
  invoice: 'INV-',
  quote: 'QT-',
  challan: 'DC-',
  payment: 'PAY-'
};

/**
 * Get the next auto-incremented number for a given document type.
 * Uses a Firestore transaction to atomically read-increment-write.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} collections
 * @param {string} orgId
 * @param {string} type - 'invoice' | 'quote' | 'challan' | 'payment'
 * @returns {Promise<string>} Formatted number like "INV-000001"
 */
async function getNextNumber(db, collections, orgId, type) {
  if (!PREFIXES[type]) {
    throw new Error(`Invalid numbering type: ${type}`);
  }

  const docId = `${orgId}_${type}`;
  const seqRef = db.collection(collections.invNumberSequences).doc(docId);

  const result = await db.runTransaction(async (transaction) => {
    const seqDoc = await transaction.get(seqRef);

    let currentNumber;
    if (!seqDoc.exists) {
      // Check settings for custom start number and prefix
      const settingsSnap = await transaction.get(
        db.collection(collections.invSettings)
          .where('orgId', '==', orgId)
      );

      let startNumber = 1;
      let prefix = PREFIXES[type];

      if (!settingsSnap.empty) {
        const settings = settingsSnap.docs[0].data();
        if (type === 'invoice' && settings.invoiceStartNumber) {
          startNumber = settings.invoiceStartNumber;
        }
        if (type === 'invoice' && settings.invoiceNumberPrefix) {
          prefix = settings.invoiceNumberPrefix;
        }
        if (type === 'quote' && settings.quoteNumberPrefix) {
          prefix = settings.quoteNumberPrefix;
        }
        if (type === 'challan' && settings.challanNumberPrefix) {
          prefix = settings.challanNumberPrefix;
        }
        if (type === 'payment' && settings.paymentNumberPrefix) {
          prefix = settings.paymentNumberPrefix;
        }
      }

      currentNumber = startNumber;
      transaction.set(seqRef, {
        orgId,
        type,
        prefix,
        currentNumber,
        updatedAt: FieldValue.serverTimestamp()
      });

      return `${prefix}${String(currentNumber).padStart(6, '0')}`;
    } else {
      const data = seqDoc.data();
      currentNumber = (data.currentNumber || 0) + 1;
      const prefix = data.prefix || PREFIXES[type];

      transaction.update(seqRef, {
        currentNumber,
        updatedAt: FieldValue.serverTimestamp()
      });

      return `${prefix}${String(currentNumber).padStart(6, '0')}`;
    }
  });

  return result;
}

module.exports = { getNextNumber };
