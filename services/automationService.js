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
          phoneNumberId: process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID,
          businessAccountId: process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID
        };
      } else {
        // Use restaurant's own WhatsApp credentials
        credentials = {
          accessToken: whatsappSettings.accessToken,
          phoneNumberId: whatsappSettings.phoneNumberId,
          businessAccountId: whatsappSettings.businessAccountId
        };
      }

      if (!credentials.accessToken || !credentials.phoneNumberId || !credentials.businessAccountId) {
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
      if (!order.customerDisplay?.phone && !order.customer?.phone) {
        return null;
      }

      const phone = order.customerDisplay?.phone || order.customer?.phone;
      const name = order.customerDisplay?.name || order.customer?.name || 'Walk-in Customer';

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
        email: order.customer?.email || order.customerDisplay?.email || null,
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
}

module.exports = new AutomationService();

