const OpenAI = require('openai');

class AIInvoiceOCRService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Extract invoice data from image using OpenAI Vision
   * @param {string} imageUrl - URL of invoice image
   * @returns {Promise<Object>} Extracted invoice data
   */
  async extractInvoiceData(imageUrl) {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this invoice image and extract all relevant data. Return ONLY valid JSON in this exact format:

{
  "invoiceNumber": "INV-12345",
  "supplierName": "Supplier Name",
  "supplierAddress": "Address if visible",
  "invoiceDate": "2025-01-15",
  "dueDate": "2025-02-15",
  "items": [
    {
      "name": "Item Name",
      "quantity": 10,
      "unitPrice": 100.00,
      "tax": 18.00,
      "total": 1180.00
    }
  ],
  "subtotal": 10000.00,
  "taxAmount": 1800.00,
  "totalAmount": 11800.00,
  "paymentTerms": "Net 30"
}

Rules:
1. Extract invoice number, supplier name, dates
2. Extract all line items with quantities, prices, tax, totals
3. Extract subtotal, tax amount, total amount
4. Extract payment terms if visible
5. Convert all dates to YYYY-MM-DD format
6. Convert all prices to numbers (remove currency symbols)
7. If any field is not visible, use null or empty string
8. Return ONLY the JSON, no other text`
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        max_tokens: 2000,
        temperature: 0
      });

      const responseText = response.choices[0].message.content.trim();
      
      // Try to extract JSON from markdown code block
      let jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
                     responseText.match(/```\s*([\s\S]*?)\s*```/);
      
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      const extractedData = JSON.parse(jsonText);

      return {
        success: true,
        extractedData,
        rawResponse: responseText
      };

    } catch (error) {
      console.error('Invoice OCR error:', error);
      return {
        success: false,
        error: error.message,
        extractedData: null
      };
    }
  }

  /**
   * Match extracted invoice data with Purchase Order
   * @param {Object} extractedData - Extracted invoice data
   * @param {string} restaurantId - Restaurant ID
   * @returns {Promise<Object>} Matched PO and discrepancies
   */
  async matchWithPurchaseOrder(extractedData, restaurantId) {
    try {
      // Try to find PO by supplier name and approximate date
      const { db, collections } = require('../firebase');
      
      // Get suppliers matching the name
      const suppliersSnapshot = await db.collection(collections.suppliers)
        .where('restaurantId', '==', restaurantId)
        .get();

      let matchedSupplier = null;
      for (const doc of suppliersSnapshot.docs) {
        const supplier = doc.data();
        if (supplier.name && extractedData.supplierName &&
            supplier.name.toLowerCase().includes(extractedData.supplierName.toLowerCase())) {
          matchedSupplier = { id: doc.id, ...supplier };
          break;
        }
      }

      if (!matchedSupplier) {
        return {
          matched: false,
          message: 'No matching supplier found'
        };
      }

      // Get recent POs from this supplier
      const invoiceDate = new Date(extractedData.invoiceDate);
      const startDate = new Date(invoiceDate);
      startDate.setDate(startDate.getDate() - 30); // Look 30 days before invoice date
      const endDate = new Date(invoiceDate);
      endDate.setDate(endDate.getDate() + 7); // Look 7 days after invoice date

      const poSnapshot = await db.collection(collections.purchaseOrders)
        .where('restaurantId', '==', restaurantId)
        .where('supplierId', '==', matchedSupplier.id)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate)
        .get();

      // Find best matching PO (by total amount and items)
      let bestMatch = null;
      let bestMatchScore = 0;

      poSnapshot.forEach(doc => {
        const po = doc.data();
        const poTotal = po.totalAmount || 0;
        const invTotal = extractedData.totalAmount || 0;
        
        // Calculate match score
        let score = 0;
        
        // Total amount match (within 5%)
        if (Math.abs(poTotal - invTotal) / Math.max(poTotal, invTotal) < 0.05) {
          score += 50;
        }
        
        // Item count match
        const poItemCount = po.items?.length || 0;
        const invItemCount = extractedData.items?.length || 0;
        if (poItemCount === invItemCount) {
          score += 30;
        }
        
        // Item name matches
        if (po.items && extractedData.items) {
          let itemMatches = 0;
          extractedData.items.forEach(invItem => {
            const matched = po.items.find(poItem => 
              poItem.inventoryItemName && invItem.name &&
              poItem.inventoryItemName.toLowerCase().includes(invItem.name.toLowerCase())
            );
            if (matched) itemMatches++;
          });
          score += (itemMatches / Math.max(poItemCount, invItemCount)) * 20;
        }

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestMatch = { id: doc.id, ...po, matchScore: score };
        }
      });

      if (bestMatch && bestMatchScore >= 50) {
        return {
          matched: true,
          purchaseOrder: bestMatch,
          matchScore: bestMatchScore,
          supplier: matchedSupplier
        };
      }

      return {
        matched: false,
        message: 'No matching purchase order found',
        supplier: matchedSupplier
      };

    } catch (error) {
      console.error('Match with PO error:', error);
      return {
        matched: false,
        error: error.message
      };
    }
  }
}

module.exports = new AIInvoiceOCRService();



