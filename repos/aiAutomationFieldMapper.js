/**
 * aiAutomationFieldMapper.js — Field maps for Phase 9 AI/Automation/Misc collections.
 *
 * Collections (20 tables):
 *   Bolna: bolnaAgents, phoneCalls
 *   DineAI: dineai_settings, dineai_usage, dineai_knowledge, dineai_realtime_sessions, dineai_realtime_function_calls, dineai_cheap_sessions
 *   AI Usage: chatgptUsage, aiUsage, aiInsightsUsage
 *   Google Reviews: googleReviewSettings, googleReviewsCache, googleBusinessTokens
 *   WhatsApp: whatsappOrderingConfig, whatsappConversationLogs
 *   Automations: automations, automationTemplates, automationSettings, automationLogs
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

// ── bolnaAgents ─────────────────────────────────────────────────────────────

const BOLNA_AGENT_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  bolnaAgentId: 'bolna_agent_id',
  name: 'name',
  language: 'language',
  voice: 'voice',
  greeting: 'greeting',
  status: 'status',
  capabilities: 'capabilities',
  phoneNumber: 'phone_number',
  phoneNumberId: 'phone_number_id',
  telephonyProvider: 'telephony_provider',
  callStats: 'call_stats',
  connectedProviders: 'connected_providers',
  preferredProvider: 'preferred_provider',
  lastMenuSync: 'last_menu_sync',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
};

const BOLNA_AGENT_JSONB_COLUMNS = new Set(['capabilities', 'call_stats', 'connected_providers', 'extra_data']);
const bolnaAgentToPgRow = makeToPgRow(BOLNA_AGENT_FIELD_MAP, BOLNA_AGENT_JSONB_COLUMNS);
const bolnaAgentToFirestoreObj = makeToFirestoreObj(buildReverseMap(BOLNA_AGENT_FIELD_MAP));

// ── phoneCalls ──────────────────────────────────────────────────────────────

const PHONE_CALL_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  bolnaExecutionId: 'bolna_execution_id',
  status: 'status',
  callerNumber: 'caller_number',
  duration: 'duration',
  transcript: 'transcript',
  summary: 'summary',
  recordingUrl: 'recording_url',
  metadata: 'metadata',
  createdAt: 'created_at',
};

const PHONE_CALL_JSONB_COLUMNS = new Set(['metadata', 'extra_data']);
const phoneCallToPgRow = makeToPgRow(PHONE_CALL_FIELD_MAP, PHONE_CALL_JSONB_COLUMNS);
const phoneCallToFirestoreObj = makeToFirestoreObj(buildReverseMap(PHONE_CALL_FIELD_MAP));

// ── dineai_settings ─────────────────────────────────────────────────────────

const DINEAI_SETTINGS_FIELD_MAP = {
  id: 'id',
  enabled: 'enabled',
  defaultVoice: 'default_voice',
  voiceMode: 'voice_mode',
  responseMode: 'response_mode',
  enableKnowledgeBase: 'enable_knowledge_base',
  enableGreetings: 'enable_greetings',
  greetingStyle: 'greeting_style',
  maxSessionDuration: 'max_session_duration',
  features: 'features',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
};

const DINEAI_SETTINGS_JSONB_COLUMNS = new Set(['features', 'extra_data']);
const dineaiSettingsToPgRow = makeToPgRow(DINEAI_SETTINGS_FIELD_MAP, DINEAI_SETTINGS_JSONB_COLUMNS);
const dineaiSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_SETTINGS_FIELD_MAP));

// ── dineai_usage ────────────────────────────────────────────────────────────

const DINEAI_USAGE_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  restaurantId: 'restaurant_id',
  date: 'date',
  count: 'count',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const DINEAI_USAGE_JSONB_COLUMNS = new Set(['extra_data']);
const dineaiUsageToPgRow = makeToPgRow(DINEAI_USAGE_FIELD_MAP, DINEAI_USAGE_JSONB_COLUMNS);
const dineaiUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_USAGE_FIELD_MAP));

// ── dineai_knowledge ────────────────────────────────────────────────────────

const DINEAI_KNOWLEDGE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  documentId: 'document_id',
  title: 'title',
  type: 'type',
  category: 'category',
  source: 'source',
  tags: 'tags',
  chunkCount: 'chunk_count',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const DINEAI_KNOWLEDGE_JSONB_COLUMNS = new Set(['tags', 'extra_data']);
const dineaiKnowledgeToPgRow = makeToPgRow(DINEAI_KNOWLEDGE_FIELD_MAP, DINEAI_KNOWLEDGE_JSONB_COLUMNS);
const dineaiKnowledgeToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_KNOWLEDGE_FIELD_MAP));

// ── dineai_realtime_sessions ────────────────────────────────────────────────

const DINEAI_RT_SESSION_FIELD_MAP = {
  id: 'id',
  sessionId: 'session_id',
  restaurantId: 'restaurant_id',
  userId: 'user_id',
  userRole: 'user_role',
  voiceMode: 'voice_mode',
  status: 'status',
  createdAt: 'created_at',
  endedAt: 'ended_at',
};

const DINEAI_RT_SESSION_JSONB_COLUMNS = new Set(['extra_data']);
const dineaiRtSessionToPgRow = makeToPgRow(DINEAI_RT_SESSION_FIELD_MAP, DINEAI_RT_SESSION_JSONB_COLUMNS);
const dineaiRtSessionToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_RT_SESSION_FIELD_MAP));

// ── dineai_realtime_function_calls (subcollection flattened) ────────────────

const DINEAI_RT_FUNC_CALL_FIELD_MAP = {
  id: 'id',
  sessionId: 'session_id',
  functionName: 'function_name',
  args: 'args',
  success: 'success',
  timestamp: 'timestamp',
};

const DINEAI_RT_FUNC_CALL_JSONB_COLUMNS = new Set(['args', 'extra_data']);
const dineaiRtFuncCallToPgRow = makeToPgRow(DINEAI_RT_FUNC_CALL_FIELD_MAP, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS);
const dineaiRtFuncCallToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_RT_FUNC_CALL_FIELD_MAP));

// ── dineai_cheap_sessions ───────────────────────────────────────────────────

const DINEAI_CHEAP_SESSION_FIELD_MAP = {
  id: 'id',
  sessionId: 'session_id',
  restaurantId: 'restaurant_id',
  userId: 'user_id',
  userRole: 'user_role',
  voiceMode: 'voice_mode',
  status: 'status',
  messageCount: 'message_count',
  lastMessageAt: 'last_message_at',
  createdAt: 'created_at',
  endedAt: 'ended_at',
};

const DINEAI_CHEAP_SESSION_JSONB_COLUMNS = new Set(['extra_data']);
const dineaiCheapSessionToPgRow = makeToPgRow(DINEAI_CHEAP_SESSION_FIELD_MAP, DINEAI_CHEAP_SESSION_JSONB_COLUMNS);
const dineaiCheapSessionToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINEAI_CHEAP_SESSION_FIELD_MAP));

// ── chatgptUsage ────────────────────────────────────────────────────────────

const CHATGPT_USAGE_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  ipAddress: 'ip_address',
  date: 'date',
  callCount: 'call_count',
  totalTokensUsed: 'total_tokens_used',
  lastCallAt: 'last_call_at',
  ipAddresses: 'ip_addresses',
  userIds: 'user_ids',
  type: 'type',
  createdAt: 'created_at',
};

const CHATGPT_USAGE_JSONB_COLUMNS = new Set(['ip_addresses', 'user_ids', 'extra_data']);
const chatgptUsageToPgRow = makeToPgRow(CHATGPT_USAGE_FIELD_MAP, CHATGPT_USAGE_JSONB_COLUMNS);
const chatgptUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(CHATGPT_USAGE_FIELD_MAP));

// ── aiUsage ─────────────────────────────────────────────────────────────────

const AI_USAGE_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  creditsUsed: 'credits_used',
  creditsMonth: 'credits_month',
  lastUpdated: 'last_updated',
};

const AI_USAGE_JSONB_COLUMNS = new Set(['extra_data']);
const aiUsageToPgRow = makeToPgRow(AI_USAGE_FIELD_MAP, AI_USAGE_JSONB_COLUMNS);
const aiUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(AI_USAGE_FIELD_MAP));

// ── aiInsightsUsage ─────────────────────────────────────────────────────────

const AI_INSIGHTS_USAGE_FIELD_MAP = {
  id: 'id',
  date: 'date',
  count: 'count',
  updatedAt: 'updated_at',
};

const AI_INSIGHTS_USAGE_JSONB_COLUMNS = new Set(['extra_data']);
const aiInsightsUsageToPgRow = makeToPgRow(AI_INSIGHTS_USAGE_FIELD_MAP, AI_INSIGHTS_USAGE_JSONB_COLUMNS);
const aiInsightsUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(AI_INSIGHTS_USAGE_FIELD_MAP));

// ── googleReviewSettings ────────────────────────────────────────────────────

const GOOGLE_REVIEW_SETTINGS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  googleReviewUrl: 'google_review_url',
  aiEnabled: 'ai_enabled',
  customMessage: 'custom_message',
  qrCodeUrl: 'qr_code_url',
  googleAccountConnected: 'google_account_connected',
  connectedEmail: 'connected_email',
  updatedAt: 'updated_at',
};

const GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS = new Set(['extra_data']);
const googleReviewSettingsToPgRow = makeToPgRow(GOOGLE_REVIEW_SETTINGS_FIELD_MAP, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS);
const googleReviewSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(GOOGLE_REVIEW_SETTINGS_FIELD_MAP));

// ── googleReviewsCache ──────────────────────────────────────────────────────

const GOOGLE_REVIEWS_CACHE_FIELD_MAP = {
  id: 'id',
  response: 'response',
  cachedAt: 'cached_at',
};

const GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS = new Set(['response', 'extra_data']);
const googleReviewsCacheToPgRow = makeToPgRow(GOOGLE_REVIEWS_CACHE_FIELD_MAP, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS);
const googleReviewsCacheToFirestoreObj = makeToFirestoreObj(buildReverseMap(GOOGLE_REVIEWS_CACHE_FIELD_MAP));

// ── googleBusinessTokens ────────────────────────────────────────────────────

const GOOGLE_BIZ_TOKENS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  expiresAt: 'expires_at',
  userId: 'user_id',
  connectedEmail: 'connected_email',
  connectedAt: 'connected_at',
};

const GOOGLE_BIZ_TOKENS_JSONB_COLUMNS = new Set(['extra_data']);
const googleBizTokensToPgRow = makeToPgRow(GOOGLE_BIZ_TOKENS_FIELD_MAP, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS);
const googleBizTokensToFirestoreObj = makeToFirestoreObj(buildReverseMap(GOOGLE_BIZ_TOKENS_FIELD_MAP));

// ── whatsappOrderingConfig ──────────────────────────────────────────────────

const WHATSAPP_CONFIG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  accessToken: 'access_token',
  phoneNumberId: 'phone_number_id',
  businessAccountId: 'business_account_id',
  webhookVerifyToken: 'webhook_verify_token',
  greeting: 'greeting',
  menuHeader: 'menu_header',
  paymentMode: 'payment_mode',
  paymentLink: 'payment_link',
  autoAcceptOrders: 'auto_accept_orders',
  enabled: 'enabled',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const WHATSAPP_CONFIG_JSONB_COLUMNS = new Set(['extra_data']);
const whatsappConfigToPgRow = makeToPgRow(WHATSAPP_CONFIG_FIELD_MAP, WHATSAPP_CONFIG_JSONB_COLUMNS);
const whatsappConfigToFirestoreObj = makeToFirestoreObj(buildReverseMap(WHATSAPP_CONFIG_FIELD_MAP));

// ── whatsappConversationLogs ────────────────────────────────────────────────

const WHATSAPP_LOG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  customerPhone: 'customer_phone',
  contactName: 'contact_name',
  incomingType: 'incoming_type',
  incomingText: 'incoming_text',
  interactiveId: 'interactive_id',
  responseCount: 'response_count',
  createdAt: 'created_at',
};

const WHATSAPP_LOG_JSONB_COLUMNS = new Set(['extra_data']);
const whatsappLogToPgRow = makeToPgRow(WHATSAPP_LOG_FIELD_MAP, WHATSAPP_LOG_JSONB_COLUMNS);
const whatsappLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(WHATSAPP_LOG_FIELD_MAP));

// ── automations ─────────────────────────────────────────────────────────────

const AUTOMATION_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  trigger: 'trigger',
  action: 'action',
  enabled: 'enabled',
  stats: 'stats',
  lastTriggered: 'last_triggered',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const AUTOMATION_JSONB_COLUMNS = new Set(['trigger', 'action', 'stats', 'extra_data']);
const automationToPgRow = makeToPgRow(AUTOMATION_FIELD_MAP, AUTOMATION_JSONB_COLUMNS);
const automationToFirestoreObj = makeToFirestoreObj(buildReverseMap(AUTOMATION_FIELD_MAP));

// ── automationTemplates ─────────────────────────────────────────────────────

const AUTOMATION_TEMPLATE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  description: 'description',
  trigger: 'trigger',
  action: 'action',
  category: 'category',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const AUTOMATION_TEMPLATE_JSONB_COLUMNS = new Set(['trigger', 'action', 'extra_data']);
const automationTemplateToPgRow = makeToPgRow(AUTOMATION_TEMPLATE_FIELD_MAP, AUTOMATION_TEMPLATE_JSONB_COLUMNS);
const automationTemplateToFirestoreObj = makeToFirestoreObj(buildReverseMap(AUTOMATION_TEMPLATE_FIELD_MAP));

// ── automationSettings ──────────────────────────────────────────────────────

const AUTOMATION_SETTINGS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  type: 'type',
  mode: 'mode',
  connected: 'connected',
  accessToken: 'access_token',
  phoneNumberId: 'phone_number_id',
  businessAccountId: 'business_account_id',
  webhookVerifyToken: 'webhook_verify_token',
  phoneNumber: 'phone_number',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const AUTOMATION_SETTINGS_JSONB_COLUMNS = new Set(['extra_data']);
const automationSettingsToPgRow = makeToPgRow(AUTOMATION_SETTINGS_FIELD_MAP, AUTOMATION_SETTINGS_JSONB_COLUMNS);
const automationSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(AUTOMATION_SETTINGS_FIELD_MAP));

// ── automationLogs ──────────────────────────────────────────────────────────

const AUTOMATION_LOG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  automationId: 'automation_id',
  type: 'type',
  triggerType: 'trigger_type',
  customerId: 'customer_id',
  phone: 'phone',
  contactName: 'contact_name',
  customerName: 'customer_name',
  message: 'message',
  messageId: 'message_id',
  orderId: 'order_id',
  amount: 'amount',
  direction: 'direction',
  status: 'status',
  timestamp: 'timestamp',
  createdAt: 'created_at',
};

const AUTOMATION_LOG_JSONB_COLUMNS = new Set(['extra_data']);
const automationLogToPgRow = makeToPgRow(AUTOMATION_LOG_FIELD_MAP, AUTOMATION_LOG_JSONB_COLUMNS);
const automationLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(AUTOMATION_LOG_FIELD_MAP));

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Bolna
  bolnaAgentToPgRow, bolnaAgentToFirestoreObj, BOLNA_AGENT_JSONB_COLUMNS, BOLNA_AGENT_FIELD_MAP,
  phoneCallToPgRow, phoneCallToFirestoreObj, PHONE_CALL_JSONB_COLUMNS, PHONE_CALL_FIELD_MAP,
  // DineAI
  dineaiSettingsToPgRow, dineaiSettingsToFirestoreObj, DINEAI_SETTINGS_JSONB_COLUMNS, DINEAI_SETTINGS_FIELD_MAP,
  dineaiUsageToPgRow, dineaiUsageToFirestoreObj, DINEAI_USAGE_JSONB_COLUMNS, DINEAI_USAGE_FIELD_MAP,
  dineaiKnowledgeToPgRow, dineaiKnowledgeToFirestoreObj, DINEAI_KNOWLEDGE_JSONB_COLUMNS, DINEAI_KNOWLEDGE_FIELD_MAP,
  dineaiRtSessionToPgRow, dineaiRtSessionToFirestoreObj, DINEAI_RT_SESSION_JSONB_COLUMNS, DINEAI_RT_SESSION_FIELD_MAP,
  dineaiRtFuncCallToPgRow, dineaiRtFuncCallToFirestoreObj, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS, DINEAI_RT_FUNC_CALL_FIELD_MAP,
  dineaiCheapSessionToPgRow, dineaiCheapSessionToFirestoreObj, DINEAI_CHEAP_SESSION_JSONB_COLUMNS, DINEAI_CHEAP_SESSION_FIELD_MAP,
  // AI Usage
  chatgptUsageToPgRow, chatgptUsageToFirestoreObj, CHATGPT_USAGE_JSONB_COLUMNS, CHATGPT_USAGE_FIELD_MAP,
  aiUsageToPgRow, aiUsageToFirestoreObj, AI_USAGE_JSONB_COLUMNS, AI_USAGE_FIELD_MAP,
  aiInsightsUsageToPgRow, aiInsightsUsageToFirestoreObj, AI_INSIGHTS_USAGE_JSONB_COLUMNS, AI_INSIGHTS_USAGE_FIELD_MAP,
  // Google Reviews
  googleReviewSettingsToPgRow, googleReviewSettingsToFirestoreObj, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS, GOOGLE_REVIEW_SETTINGS_FIELD_MAP,
  googleReviewsCacheToPgRow, googleReviewsCacheToFirestoreObj, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS, GOOGLE_REVIEWS_CACHE_FIELD_MAP,
  googleBizTokensToPgRow, googleBizTokensToFirestoreObj, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS, GOOGLE_BIZ_TOKENS_FIELD_MAP,
  // WhatsApp
  whatsappConfigToPgRow, whatsappConfigToFirestoreObj, WHATSAPP_CONFIG_JSONB_COLUMNS, WHATSAPP_CONFIG_FIELD_MAP,
  whatsappLogToPgRow, whatsappLogToFirestoreObj, WHATSAPP_LOG_JSONB_COLUMNS, WHATSAPP_LOG_FIELD_MAP,
  // Automations
  automationToPgRow, automationToFirestoreObj, AUTOMATION_JSONB_COLUMNS, AUTOMATION_FIELD_MAP,
  automationTemplateToPgRow, automationTemplateToFirestoreObj, AUTOMATION_TEMPLATE_JSONB_COLUMNS, AUTOMATION_TEMPLATE_FIELD_MAP,
  automationSettingsToPgRow, automationSettingsToFirestoreObj, AUTOMATION_SETTINGS_JSONB_COLUMNS, AUTOMATION_SETTINGS_FIELD_MAP,
  automationLogToPgRow, automationLogToFirestoreObj, AUTOMATION_LOG_JSONB_COLUMNS, AUTOMATION_LOG_FIELD_MAP,
};
