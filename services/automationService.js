/**
 * Automation Engine Service
 * Handles all automation flows and triggers
 */

const { db, collections } = require('../firebase');
const whatsappService = require('./whatsappService');

class AutomationService {
  /**
   * Process automation trigger
   */
  async processTrigger(restaurantId, triggerType, triggerData) {
    try {
      // Get active automations for this trigger type
      const automationsRef = db.collection(collections.automations)
        .where('restaurantId', '==', restaurantId)
        .where('enabled', '==', true)
        .where('trigger.type', '==', triggerType);

      const snapshot = await automationsRef.get();

      if (snapshot.empty) {
        return { success: true, processed: 0 };
      }

      const results = [];

      for (const doc of snapshot.docs) {
        const automation = { id: doc.id, ...doc.data() };
        
        // Check if conditions are met
        if (this.checkConditions(automation.conditions, triggerData)) {
          const result = await this.executeAutomation(automation, triggerData);
          results.push(result);
        }
      }

      return {
        success: true,
        processed: results.length,
        results
      };
    } catch (error) {
      console.error('Error processing automation trigger:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if automation conditions are met
   */
  checkConditions(conditions, triggerData) {
    if (!conditions || conditions.length === 0) {
      return true;
    }

    for (const condition of conditions) {
      switch (condition.type) {
        case 'order_amount':
          if (triggerData.orderAmount < condition.value) {
            return false;
          }
          break;
        case 'days_since_last_visit':
          if (triggerData.daysSinceLastVisit < condition.value) {
            return false;
          }
          break;
        case 'customer_segment':
          if (triggerData.customerSegment !== condition.value) {
            return false;
          }
          break;
        case 'rating':
          if (triggerData.rating && triggerData.rating >= condition.value) {
            return false;
          }
          break;
        default:
          break;
      }
    }

    return true;
  }

  /**
   * Execute automation
   */
  async executeAutomation(automation, triggerData) {
    try {
      const result = {
        automationId: automation.id,
        automationName: automation.name,
        success: false,
        messageId: null,
        error: null
      };

      // Get customer data
      const customer = await this.getCustomerData(triggerData.customerId, automation.restaurantId);

      if (!customer || !customer.phone) {
        result.error = 'Customer phone not found';
        return result;
      }

      // Get WhatsApp credentials
      const whatsappSettings = await this.getWhatsAppSettings(automation.restaurantId);

      if (!whatsappSettings || !whatsappSettings.connected) {
        result.error = 'WhatsApp not connected';
        return result;
      }

      // Initialize WhatsApp service based on mode
      let credentials;
      if (whatsappSettings.mode === 'dineopen') {
        // Use DineOpen's shared WhatsApp credentials
        credentials = {
          accessToken: process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: '879916941871710', // Hardcoded for now
          businessAccountId: process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID
        };
      } else {
        // Use restaurant's own WhatsApp credentials
        credentials = {
          accessToken: whatsappSettings.accessToken,
          phoneNumberId: '879916941871710', // Hardcoded for now
          businessAccountId: whatsappSettings.businessAccountId
        };
      }

      if (!credentials.accessToken) {
        result.error = 'WhatsApp credentials not configured';
        return result;
      }

      // Initialize WhatsApp service
      await whatsappService.initialize(automation.restaurantId, credentials);

      // Prepare message with personalization
      const message = this.personalizeMessage(automation.template.message, customer, triggerData);

      // Send message
      let sendResult;
      if (automation.template.type === 'template') {
        // Use template message
        sendResult = await whatsappService.sendTemplateMessage(
          customer.phone,
          automation.template.name,
          automation.template.language || 'en',
          this.getTemplateParameters(automation.template.message, customer, triggerData)
        );
      } else {
        // Use text message
        sendResult = await whatsappService.sendTextMessage(customer.phone, message);
      }

      if (sendResult.success) {
        result.success = true;
        result.messageId = sendResult.messageId;

        // Log message
        await this.logMessage(automation.restaurantId, {
          automationId: automation.id,
          customerId: customer.id,
          phone: customer.phone,
          message: message,
          messageId: sendResult.messageId,
          type: automation.template.type,
          status: 'sent',
          timestamp: new Date()
        });

        // Update automation stats
        await this.updateAutomationStats(automation.id, 'sent');
      } else {
        result.error = sendResult.error;
      }

      return result;
    } catch (error) {
      console.error('Error executing automation:', error);
      return {
        automationId: automation.id,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Personalize message with customer data
   */
  personalizeMessage(message, customer, triggerData) {
    let personalized = message;

    // Replace placeholders
    personalized = personalized.replace(/\{customerName\}/g, customer.name || 'Valued Customer');
    personalized = personalized.replace(/\{restaurantName\}/g, triggerData.restaurantName || 'Restaurant');
    personalized = personalized.replace(/\{orderAmount\}/g, triggerData.orderAmount || '0');
    personalized = personalized.replace(/\{orderNumber\}/g, triggerData.orderNumber || '');
    personalized = personalized.replace(/\{couponCode\}/g, triggerData.couponCode || '');
    personalized = personalized.replace(/\{discount\}/g, triggerData.discount || '0');

    return personalized;
  }

  /**
   * Get template parameters for WhatsApp template messages
   */
  getTemplateParameters(message, customer, triggerData) {
    const params = [];
    
    // Extract parameters from message (simplified)
    if (message.includes('{customerName}')) {
      params.push(customer.name || 'Valued Customer');
    }
    if (message.includes('{orderNumber}')) {
      params.push(triggerData.orderNumber || '');
    }
    if (message.includes('{couponCode}')) {
      params.push(triggerData.couponCode || '');
    }

    return params;
  }

  /**
   * Get customer data
   */
  async getCustomerData(customerId, restaurantId) {
    try {
      const customerRef = db.collection(collections.customers).doc(customerId);
      const customerDoc = await customerRef.get();

      if (!customerDoc.exists) {
        return null;
      }

      return { id: customerDoc.id, ...customerDoc.data() };
    } catch (error) {
      console.error('Error getting customer data:', error);
      return null;
    }
  }

  /**
   * Get WhatsApp settings
   */
  async getWhatsAppSettings(restaurantId) {
    try {
      const settingsRef = db.collection(collections.automationSettings)
        .where('restaurantId', '==', restaurantId)
        .where('type', '==', 'whatsapp')
        .limit(1);

      const snapshot = await settingsRef.get();

      if (snapshot.empty) {
        return null;
      }

      return snapshot.docs[0].data();
    } catch (error) {
      console.error('Error getting WhatsApp settings:', error);
      return null;
    }
  }

  /**
   * Log message
   */
  async logMessage(restaurantId, messageData) {
    try {
      await db.collection(collections.automationLogs).add({
        restaurantId,
        ...messageData,
        createdAt: new Date()
      });
    } catch (error) {
      console.error('Error logging message:', error);
    }
  }

  /**
   * Update automation statistics
   */
  async updateAutomationStats(automationId, statType) {
    try {
      const automationRef = db.collection(collections.automations).doc(automationId);
      const automationDoc = await automationRef.get();

      if (!automationDoc.exists) {
        return;
      }

      const stats = automationDoc.data().stats || {
        sent: 0,
        delivered: 0,
        read: 0,
        converted: 0
      };

      stats[statType] = (stats[statType] || 0) + 1;

      await automationRef.update({
        stats,
        lastTriggered: new Date()
      });
    } catch (error) {
      console.error('Error updating automation stats:', error);
    }
  }

  /**
   * Sync customer data from order
   */
  async syncCustomerFromOrder(order) {
    try {
      // Check customerInfo first (new structure), then fallback to old structures
      const phone = order.customerInfo?.phone || order.customerDisplay?.phone || order.customer?.phone;
      if (!phone) {
        return null;
      }

      const name = order.customerInfo?.name || order.customerDisplay?.name || order.customer?.name || 'Walk-in Customer';

      // Check if customer exists
      const customersRef = db.collection(collections.customers)
        .where('restaurantId', '==', order.restaurantId)
        .where('phone', '==', phone)
        .limit(1);

      const snapshot = await customersRef.get();

      let customerData = {
        restaurantId: order.restaurantId,
        phone: phone,
        name: name,
        email: order.customerInfo?.email || order.customer?.email || order.customerDisplay?.email || null,
        lastVisit: order.createdAt || new Date(),
        visitCount: 1,
        totalSpend: order.totalAmount || 0,
        favoriteItems: [],
        segment: 'new',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      if (!snapshot.empty) {
        // Update existing customer
        const existingCustomer = snapshot.docs[0].data();
        customerData = {
          ...existingCustomer,
          lastVisit: order.createdAt || new Date(),
          visitCount: (existingCustomer.visitCount || 0) + 1,
          totalSpend: (existingCustomer.totalSpend || 0) + (order.totalAmount || 0),
          updatedAt: new Date()
        };

        // Update segment based on visits and spend
        if (customerData.visitCount > 1) {
          customerData.segment = 'returning';
        }
        if (customerData.totalSpend > 5000) {
          customerData.segment = 'highValue';
        }

        await db.collection(collections.customers).doc(snapshot.docs[0].id).update(customerData);
        return snapshot.docs[0].id;
      } else {
        // Create new customer
        const newCustomerRef = await db.collection(collections.customers).add(customerData);
        return newCustomerRef.id;
      }
    } catch (error) {
      console.error('Error syncing customer from order:', error);
      return null;
    }
  }

  /**
   * Send order confirmation WhatsApp message
   * Sends welcome message with order details to customer
   */
  async sendOrderConfirmationMessage(restaurantId, order) {
    try {
      // Get customer phone from order
      const phone = order.customerInfo?.phone || order.customerDisplay?.phone || order.customer?.phone;
      if (!phone) {
        console.log('📱 No phone number in order, skipping WhatsApp message');
        return { success: false, error: 'No phone number provided' };
      }

      // Get WhatsApp settings
      const whatsappSettings = await this.getWhatsAppSettings(restaurantId);
      if (!whatsappSettings || !whatsappSettings.connected) {
        console.log('📱 WhatsApp not connected for restaurant:', restaurantId);
        return { success: false, error: 'WhatsApp not connected' };
      }

      // Initialize WhatsApp service based on mode
      let credentials;
      if (whatsappSettings.mode === 'dineopen') {
        credentials = {
          accessToken: process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: '879916941871710', // Hardcoded for now
          businessAccountId: process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID
        };
      } else {
        credentials = {
          accessToken: whatsappSettings.accessToken,
          phoneNumberId: '879916941871710', // Hardcoded for now
          businessAccountId: whatsappSettings.businessAccountId
        };
      }

      if (!credentials.accessToken) {
        console.log('📱 WhatsApp credentials not configured');
        return { success: false, error: 'WhatsApp credentials not configured' };
      }

      // Initialize WhatsApp service
      await whatsappService.initialize(restaurantId, credentials);

      // Get restaurant name
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      const restaurantName = restaurantDoc.exists ? (restaurantDoc.data().name || 'Restaurant') : 'Restaurant';

      // Format customer name
      const customerName = order.customerInfo?.name || order.customerDisplay?.name || order.customer?.name || 'Valued Customer';

      // Format order details
      const orderNumber = order.dailyOrderId || order.orderNumber || order.id?.slice(-6) || 'N/A';
      const orderItems = order.items || [];
      const totalAmount = order.totalAmount || 0;
      const tableNumber = order.tableNumber || null;

      // Build order details text
      let orderDetailsText = '';
      orderItems.forEach((item, index) => {
        const itemName = item.name || 'Item';
        const quantity = item.quantity || 1;
        const price = item.price || 0;
        const itemTotal = price * quantity;
        orderDetailsText += `${index + 1}. ${itemName} x${quantity} - ₹${itemTotal}\n`;
      });

      // Build welcome message with order details
      const welcomeMessage = `🎉 Welcome to ${restaurantName}!\n\n` +
        `Thank you for your order, ${customerName}!\n\n` +
        `📋 Order Details:\n` +
        `Order #: ${orderNumber}\n` +
        (tableNumber ? `Table: ${tableNumber}\n` : '') +
        `\nItems:\n${orderDetailsText}\n` +
        `💰 Total: ₹${totalAmount}\n\n` +
        `Your order has been confirmed and is being prepared. We'll notify you once it's ready!\n\n` +
        `Thank you for choosing ${restaurantName}! 🙏`;

      // Try to send as template first (if template name is configured), otherwise send as text
      let sendResult;
      const templateName = whatsappSettings.orderConfirmationTemplate || 'jaspers_market_plain_text_v1';
      
      // For now, send as text message since template requires pre-approval
      // You can switch to template by uncommenting the template code below
      sendResult = await whatsappService.sendTextMessage(phone, welcomeMessage);

      // Alternative: Use template message (requires template to be approved by Meta)
      // const templateParams = [
      //   customerName,
      //   orderNumber,
      //   orderDetailsText,
      //   `₹${totalAmount}`
      // ];
      // sendResult = await whatsappService.sendTemplateMessage(
      //   phone,
      //   templateName,
      //   'en_US',
      //   templateParams
      // );

      if (sendResult.success) {
        console.log('✅ WhatsApp order confirmation sent successfully:', sendResult.messageId);
        
        // Log message
        await this.logMessage(restaurantId, {
          type: 'order_confirmation',
          customerPhone: phone,
          customerName: customerName,
          orderId: order.id || orderNumber,
          message: welcomeMessage,
          messageId: sendResult.messageId,
          status: 'sent',
          timestamp: new Date()
        });

        return {
          success: true,
          messageId: sendResult.messageId
        };
      } else {
        console.error('❌ Failed to send WhatsApp message:', sendResult.error);
        return {
          success: false,
          error: sendResult.error
        };
      }
    } catch (error) {
      console.error('❌ Error sending order confirmation WhatsApp:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new AutomationService();

