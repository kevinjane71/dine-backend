/**
 * DineAI Cheap Voice Routes
 * Cost-effective voice assistant endpoints
 */

const express = require('express');
const router = express.Router();
const cheapVoiceService = require('../services/dineai/DineAICheapVoiceService');
const { authenticateToken } = require('../middleware/auth');

/**
 * Start a new cheap voice session
 * POST /api/dineai/cheap-voice/session/start
 */
router.post('/dineai/cheap-voice/session/start', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.body;
    const userId = req.user?.userId || req.user?.uid;

    // Get user role from request or default
    let userRole = 'employee';
    try {
      const { getDb } = require('../firebase');
      const db = getDb();
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (!userRestaurantDoc.empty) {
        userRole = userRestaurantDoc.docs[0].data().role || 'employee';
      }
    } catch (e) {
      console.error('Error getting user role:', e);
    }

    console.log(`🎤 Starting cheap voice session for user ${userId} at restaurant ${restaurantId}`);

    const result = await cheapVoiceService.createSession(restaurantId, userId, userRole);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Generate greeting TTS
    const ttsResult = await cheapVoiceService.generateTTS(result.greeting);

    res.json({
      success: true,
      sessionId: result.sessionId,
      greeting: result.greeting,
      greetingAudio: ttsResult.success ? ttsResult.audio : null,
      audioFormat: ttsResult.format
    });
  } catch (error) {
    console.error('Error starting cheap voice session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start session'
    });
  }
});

/**
 * Process a voice message (text from Web Speech API)
 * POST /api/dineai/cheap-voice/message
 */
router.post('/dineai/cheap-voice/message', authenticateToken, async (req, res) => {
  try {
    const { sessionId, text, restaurantId } = req.body;
    const userId = req.user?.userId || req.user?.uid;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }

    // Get user role
    let userRole = 'employee';
    try {
      const { getDb } = require('../firebase');
      const db = getDb();
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (!userRestaurantDoc.empty) {
        userRole = userRestaurantDoc.docs[0].data().role || 'employee';
      }
    } catch (e) {
      console.error('Error getting user role:', e);
    }

    // Process the message
    const result = await cheapVoiceService.processMessage(
      sessionId,
      text.trim(),
      restaurantId,
      userId,
      userRole
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Generate TTS for response
    let audioData = null;
    if (result.response) {
      const ttsResult = await cheapVoiceService.generateTTS(result.response);
      if (ttsResult.success) {
        audioData = ttsResult.audio;
      }
    }

    res.json({
      success: true,
      response: result.response,
      audio: audioData,
      audioFormat: 'mp3',
      functionCalled: result.functionCalled,
      functionResult: result.functionResult,
      shouldClose: result.shouldClose,
      tokensUsed: result.tokensUsed
    });
  } catch (error) {
    console.error('Error processing voice message:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process message',
      response: "Sorry, something went wrong. Please try again."
    });
  }
});

/**
 * End a cheap voice session
 * POST /api/dineai/cheap-voice/session/end
 */
router.post('/dineai/cheap-voice/session/end', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const result = await cheapVoiceService.endSession(sessionId);

    res.json(result);
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end session'
    });
  }
});

/**
 * Generate TTS audio
 * POST /api/dineai/cheap-voice/tts
 */
router.post('/dineai/cheap-voice/tts', authenticateToken, async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }

    const result = await cheapVoiceService.generateTTS(text, voice || 'alloy');

    res.json(result);
  } catch (error) {
    console.error('Error generating TTS:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate speech'
    });
  }
});

module.exports = router;
