const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const QRCode = require('qrcode');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Get Google Review settings for a restaurant
router.get('/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
    
    if (settingsDoc.exists) {
      res.json({ success: true, settings: settingsDoc.data() });
    } else {
      res.json({ 
        success: true, 
        settings: {
          googleReviewUrl: '',
          aiEnabled: true,
          customMessage: '',
          qrCodeUrl: null
        }
      });
    }
  } catch (error) {
    console.error('Error fetching Google Review settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// Update Google Review settings
router.post('/settings/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { googleReviewUrl, aiEnabled, customMessage } = req.body;

    // Normalize the URL to ensure it's a write review URL
    let normalizedUrl = googleReviewUrl || '';
    
    if (normalizedUrl) {
      // If it's a Place ID (long alphanumeric string), construct write review URL
      if (normalizedUrl.length > 20 && !normalizedUrl.startsWith('http') && !normalizedUrl.includes('/')) {
        normalizedUrl = `https://search.google.com/local/writereview?placeid=${normalizedUrl}`;
      }
      // If it's a Google Maps URL, try to extract Place ID
      else if (normalizedUrl.includes('maps/place/')) {
        const placeIdMatch = normalizedUrl.match(/place\/([^\/]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      }
      // If it's already a write review URL, keep it
      else if (!normalizedUrl.includes('writereview') && !normalizedUrl.includes('placeid')) {
        // If it's a regular Google Maps URL, try to extract Place ID
        const placeIdMatch = normalizedUrl.match(/placeid=([^&]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      }
    }

    const settings = {
      restaurantId,
      googleReviewUrl: normalizedUrl,
      aiEnabled: aiEnabled !== undefined ? aiEnabled : true,
      customMessage: customMessage || '',
      updatedAt: new Date()
    };

    await db.collection('googleReviewSettings').doc(restaurantId).set(settings, { merge: true });

    // Generate QR code if URL is provided - use the normalized write review URL
    if (normalizedUrl) {
      try {
        const qrCodeDataUrl = await QRCode.toDataURL(normalizedUrl, {
          width: 400,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        settings.qrCodeUrl = qrCodeDataUrl;
        await db.collection('googleReviewSettings').doc(restaurantId).update({ qrCodeUrl: qrCodeDataUrl });
      } catch (qrError) {
        console.error('Error generating QR code:', qrError);
      }
    }

    res.json({ success: true, settings, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Error updating Google Review settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// Generate QR code for Google Review URL
router.post('/generate-qr/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    let { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    // Normalize URL to ensure it's a write review URL
    if (url.length > 20 && !url.startsWith('http') && !url.includes('/')) {
      // Assume it's a Place ID
      url = `https://search.google.com/local/writereview?placeid=${url}`;
    } else if (url.includes('maps/place/')) {
      // Extract Place ID from Google Maps URL
      const placeIdMatch = url.match(/place\/([^\/]+)/);
      if (placeIdMatch) {
        url = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
      }
    } else if (!url.includes('writereview') && !url.includes('placeid')) {
      // Try to extract Place ID from URL
      const placeIdMatch = url.match(/placeid=([^&]+)/);
      if (placeIdMatch) {
        url = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
      }
    }

    const qrCodeDataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Update settings with QR code and normalized URL (use set with merge to create if doesn't exist)
    await db.collection('googleReviewSettings').doc(restaurantId).set({
      restaurantId,
      qrCodeUrl: qrCodeDataUrl,
      googleReviewUrl: url,
      updatedAt: new Date()
    }, { merge: true });

    res.json({ success: true, qrCodeUrl: qrCodeDataUrl, reviewUrl: url });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

// Generate AI review content
router.post('/generate-content/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { customerName, rating } = req.body;

    // Fetch restaurant details
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const restaurantName = restaurantData.name || 'this restaurant';
    const cuisine = restaurantData.cuisine || [];
    const address = restaurantData.address || '';

    // Generate AI review content
    const aiPrompt = `Generate a genuine, authentic Google review for a restaurant. The review should:
- Be natural and conversational (not overly promotional)
- Mention specific positive aspects (food quality, service, ambiance, value)
- Be appropriate for a ${rating || 5}-star rating
- Be between 50-200 words
- Sound like a real customer wrote it
- Follow Google Review guidelines (honest, helpful, relevant)

Restaurant Details:
- Name: ${restaurantName}
- Cuisine: ${cuisine.join(', ') || 'Various'}
- Location: ${address}

${customerName ? `Customer Name: ${customerName}` : ''}
Rating: ${rating || 5} stars

Generate a review that feels authentic and would be helpful to other customers. Return only the review text, no additional formatting.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates authentic, genuine restaurant reviews that sound like real customers wrote them. Reviews should be honest, helpful, and follow Google Review guidelines.'
        },
        {
          role: 'user',
          content: aiPrompt
        }
      ],
      temperature: 0.8,
      max_tokens: 300
    });

    const reviewContent = completion.choices[0].message.content.trim();

    res.json({ 
      success: true, 
      reviewContent,
      message: 'Review content generated successfully' 
    });
  } catch (error) {
    console.error('Error generating AI review content:', error);
    res.status(500).json({ success: false, error: 'Failed to generate review content' });
  }
});

// Get Google Review link helper (constructs Google Review URL)
router.get('/review-link/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { placeId } = req.query;

    // Get saved settings
    const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
    const savedUrl = settingsDoc.exists ? settingsDoc.data().googleReviewUrl : null;

    let reviewUrl = '';

    if (placeId) {
      // If placeId is provided, construct the write review URL
      reviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;
    } else if (savedUrl) {
      // Use saved URL, but ensure it's a write review URL
      if (savedUrl.includes('writereview') || savedUrl.includes('placeid')) {
        reviewUrl = savedUrl;
      } else if (savedUrl.includes('maps/place/')) {
        // Extract Place ID from Google Maps URL
        const placeIdMatch = savedUrl.match(/place\/([^\/]+)/);
        if (placeIdMatch) {
          reviewUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        } else {
          reviewUrl = savedUrl;
        }
      } else if (savedUrl.length > 20 && !savedUrl.startsWith('http')) {
        // Assume it's a Place ID
        reviewUrl = `https://search.google.com/local/writereview?placeid=${savedUrl}`;
      } else {
        reviewUrl = savedUrl;
      }
    } else {
      return res.json({ success: false, error: 'No Google Review URL or Place ID configured. Please add a Place ID or direct URL.' });
    }

    res.json({ success: true, reviewUrl });
  } catch (error) {
    console.error('Error getting review link:', error);
    res.status(500).json({ success: false, error: 'Failed to get review link' });
  }
});

module.exports = router;

