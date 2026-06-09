/**
 * WhatsApp Business API Service
 * Handles all WhatsApp messaging operations using Meta's WhatsApp Cloud API
 */

const axios = require('axios');

const BASE_URL = 'https://graph.facebook.com/v22.0';

class WhatsAppService {
  constructor() {
    this.baseURL = BASE_URL;
    this.accessToken = null;
    this.phoneNumberId = process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID || null;
    this.businessAccountId = null;
  }

  /**
   * Initialize WhatsApp service with restaurant credentials
   * @deprecated Use per-call credentials parameter instead for concurrency safety
   */
  async initialize(restaurantId, credentials) {
    this.accessToken = credentials.accessToken;
    this.phoneNumberId = credentials.phoneNumberId || process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID;
    this.businessAccountId = credentials.businessAccountId;
    this.restaurantId = restaurantId;
  }

  /**
   * Resolve credentials: use per-call credentials if provided, else fall back to this.*
   */
  _creds(credentials) {
    if (credentials) {
      return {
        accessToken: credentials.accessToken,
        phoneNumberId: credentials.phoneNumberId || process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID,
      };
    }
    return { accessToken: this.accessToken, phoneNumberId: this.phoneNumberId };
  }

  /**
   * Send text message
   * @param {string} to - Phone number
   * @param {string} message - Text body
   * @param {object} [credentials] - { accessToken, phoneNumberId } for concurrency-safe calls
   */
  async sendTextMessage(to, message, credentials) {
    try {
      const { accessToken, phoneNumberId } = this._creds(credentials);
      const formattedPhone = to.replace(/[\s\+\-\(\)]/g, '');

      const response = await axios.post(
        `${BASE_URL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: formattedPhone,
          type: 'text',
          text: {
            preview_url: false,
            body: message
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp send error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Send template message (pre-approved by Meta)
   * @param {object} [credentials] - { accessToken, phoneNumberId } for concurrency-safe calls
   */
  async sendTemplateMessage(to, templateName, languageCode = 'en', parameters = [], credentials) {
    try {
      const { accessToken, phoneNumberId } = this._creds(credentials);
      const formattedPhone = to.replace(/[\s\+\-\(\)]/g, '');

      const response = await axios.post(
        `${BASE_URL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: formattedPhone,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: languageCode
            },
            components: parameters.length > 0 ? [{
              type: 'body',
              parameters: parameters.map(param => ({
                type: 'text',
                text: param
              }))
            }] : []
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp template error:', error.response?.data || error.message);
      throw error; // Re-throw so callers can catch and fall back to text
    }
  }

  /**
   * Send interactive message with buttons
   * @param {object} [credentials] - { accessToken, phoneNumberId } for concurrency-safe calls
   */
  async sendInteractiveMessage(to, message, buttons, credentials) {
    try {
      const { accessToken, phoneNumberId } = this._creds(credentials);
      const formattedPhone = to.replace(/[\s\+\-\(\)]/g, '');

      const response = await axios.post(
        `${BASE_URL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: formattedPhone,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: message
            },
            action: {
              buttons: buttons.map((btn, index) => ({
                type: 'reply',
                reply: {
                  id: `btn_${index}`,
                  title: btn.title
                }
              }))
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp interactive error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Verify webhook signature (for incoming messages)
   */
  verifyWebhookSignature(payload, signature, secret) {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return hash === signature;
  }

  /**
   * Handle incoming webhook message
   */
  handleIncomingMessage(webhookData) {
    try {
      const entry = webhookData.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (!value?.messages) {
        return null;
      }

      const message = value.messages[0];
      const contact = value.contacts?.[0];

      // Extract text and media info based on message type
      let text = '';
      let mediaId = null;
      let mimeType = null;
      let filename = null;
      let caption = null;
      let latitude = null;
      let longitude = null;
      let locationName = null;

      switch (message.type) {
        case 'text':
          text = message.text?.body || '';
          break;
        case 'image':
          mediaId = message.image?.id;
          mimeType = message.image?.mime_type;
          caption = message.image?.caption || '';
          text = caption || '[Image]';
          break;
        case 'video':
          mediaId = message.video?.id;
          mimeType = message.video?.mime_type;
          caption = message.video?.caption || '';
          text = caption || '[Video]';
          break;
        case 'audio':
          mediaId = message.audio?.id;
          mimeType = message.audio?.mime_type;
          text = '[Audio message]';
          break;
        case 'document':
          mediaId = message.document?.id;
          mimeType = message.document?.mime_type;
          filename = message.document?.filename || 'document';
          caption = message.document?.caption || '';
          text = caption || `[Document: ${filename}]`;
          break;
        case 'sticker':
          mediaId = message.sticker?.id;
          mimeType = message.sticker?.mime_type;
          text = '[Sticker]';
          break;
        case 'location':
          latitude = message.location?.latitude;
          longitude = message.location?.longitude;
          locationName = message.location?.name || message.location?.address || '';
          text = locationName || `[Location: ${latitude}, ${longitude}]`;
          break;
        case 'contacts':
          text = '[Contact shared]';
          break;
        case 'reaction':
          text = message.reaction?.emoji || '[Reaction]';
          break;
        default:
          text = message.text?.body || '';
      }

      return {
        from: message.from,
        messageId: message.id,
        timestamp: message.timestamp,
        type: message.type,
        text,
        contactName: contact?.profile?.name || '',
        contactPhone: message.from,
        mediaId,
        mimeType,
        filename,
        caption,
        latitude,
        longitude,
        locationName
      };
    } catch (error) {
      console.error('Error handling incoming message:', error);
      return null;
    }
  }

  /**
   * Send interactive list message (for menus with many items)
   * @param {object} [credentials] - { accessToken, phoneNumberId } for concurrency-safe calls
   */
  async sendListMessage(to, { headerText, bodyText, footerText, buttonText, sections }, credentials) {
    try {
      const { accessToken, phoneNumberId } = this._creds(credentials);
      const formattedPhone = to.replace(/[\s\+\-\(\)]/g, '');

      const response = await axios.post(
        `${BASE_URL}/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: formattedPhone,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: headerText ? { type: 'text', text: headerText } : undefined,
            body: { text: bodyText },
            footer: footerText ? { text: footerText } : undefined,
            action: {
              button: buttonText || 'View Menu',
              sections: sections
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('WhatsApp list message error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Get message status
   */
  async getMessageStatus(messageId) {
    try {
      return {
        success: true,
        status: 'sent',
        messageId: messageId
      };
    } catch (error) {
      console.error('Error getting message status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new WhatsAppService();
