/**
 * aiAutomationRepo.js — PostgreSQL data access for Phase 9 AI/Automation/Misc collections (20 tables).
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
  bolnaAgentToPgRow, bolnaAgentToFirestoreObj, BOLNA_AGENT_JSONB_COLUMNS,
  phoneCallToPgRow, phoneCallToFirestoreObj, PHONE_CALL_JSONB_COLUMNS,
  dineaiSettingsToPgRow, dineaiSettingsToFirestoreObj, DINEAI_SETTINGS_JSONB_COLUMNS,
  dineaiUsageToPgRow, dineaiUsageToFirestoreObj, DINEAI_USAGE_JSONB_COLUMNS,
  dineaiKnowledgeToPgRow, dineaiKnowledgeToFirestoreObj, DINEAI_KNOWLEDGE_JSONB_COLUMNS,
  dineaiRtSessionToPgRow, dineaiRtSessionToFirestoreObj, DINEAI_RT_SESSION_JSONB_COLUMNS,
  dineaiRtFuncCallToPgRow, dineaiRtFuncCallToFirestoreObj, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS,
  dineaiCheapSessionToPgRow, dineaiCheapSessionToFirestoreObj, DINEAI_CHEAP_SESSION_JSONB_COLUMNS,
  chatgptUsageToPgRow, chatgptUsageToFirestoreObj, CHATGPT_USAGE_JSONB_COLUMNS,
  aiUsageToPgRow, aiUsageToFirestoreObj, AI_USAGE_JSONB_COLUMNS,
  aiInsightsUsageToPgRow, aiInsightsUsageToFirestoreObj, AI_INSIGHTS_USAGE_JSONB_COLUMNS,
  googleReviewSettingsToPgRow, googleReviewSettingsToFirestoreObj, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS,
  googleReviewsCacheToPgRow, googleReviewsCacheToFirestoreObj, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS,
  googleBizTokensToPgRow, googleBizTokensToFirestoreObj, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS,
  whatsappConfigToPgRow, whatsappConfigToFirestoreObj, WHATSAPP_CONFIG_JSONB_COLUMNS,
  whatsappLogToPgRow, whatsappLogToFirestoreObj, WHATSAPP_LOG_JSONB_COLUMNS,
  automationToPgRow, automationToFirestoreObj, AUTOMATION_JSONB_COLUMNS,
  automationTemplateToPgRow, automationTemplateToFirestoreObj, AUTOMATION_TEMPLATE_JSONB_COLUMNS,
  automationSettingsToPgRow, automationSettingsToFirestoreObj, AUTOMATION_SETTINGS_JSONB_COLUMNS,
  automationLogToPgRow, automationLogToFirestoreObj, AUTOMATION_LOG_JSONB_COLUMNS,
} = require('./aiAutomationFieldMapper');

// ── Generic helpers ──────────────────────────────────────────────────────────

function makeUpsert(table, toPgRowFn, jsonbCols, toFsObjFn) {
  return async function upsert(docId, data) {
    const pgRow = toPgRowFn({ id: docId, ...data });
    if (!pgRow.id) pgRow.id = docId;
    const q = buildUpsert(table, pgRow, jsonbCols);
    const result = await query(q.text, q.values);
    return result.rows.length > 0 ? toFsObjFn(result.rows[0]) : null;
  };
}

function makeUpdate(table, toPgRowFn, jsonbCols) {
  return async function update(docId, updates) {
    const pgRow = toPgRowFn(updates);
    delete pgRow.id;
    const q = buildUpdate(table, docId, pgRow, jsonbCols);
    if (!q) return;
    await query(q.text, q.values);
  };
}

function makeDelete(table) {
  return async function remove(docId) {
    await query(`DELETE FROM ${table} WHERE id = $1`, [docId]);
  };
}

// ── Bolna ────────────────────────────────────────────────────────────────────
const upsertBolnaAgent = makeUpsert('bolna_agents', bolnaAgentToPgRow, BOLNA_AGENT_JSONB_COLUMNS, bolnaAgentToFirestoreObj);
const updateBolnaAgent = makeUpdate('bolna_agents', bolnaAgentToPgRow, BOLNA_AGENT_JSONB_COLUMNS);
const upsertPhoneCall = makeUpsert('phone_calls', phoneCallToPgRow, PHONE_CALL_JSONB_COLUMNS, phoneCallToFirestoreObj);

// ── DineAI ───────────────────────────────────────────────────────────────────
const upsertDineaiSettings = makeUpsert('dineai_settings', dineaiSettingsToPgRow, DINEAI_SETTINGS_JSONB_COLUMNS, dineaiSettingsToFirestoreObj);
const updateDineaiSettings = makeUpdate('dineai_settings', dineaiSettingsToPgRow, DINEAI_SETTINGS_JSONB_COLUMNS);
const upsertDineaiUsage = makeUpsert('dineai_usage', dineaiUsageToPgRow, DINEAI_USAGE_JSONB_COLUMNS, dineaiUsageToFirestoreObj);
const updateDineaiUsage = makeUpdate('dineai_usage', dineaiUsageToPgRow, DINEAI_USAGE_JSONB_COLUMNS);
const upsertDineaiKnowledge = makeUpsert('dineai_knowledge', dineaiKnowledgeToPgRow, DINEAI_KNOWLEDGE_JSONB_COLUMNS, dineaiKnowledgeToFirestoreObj);
const deleteDineaiKnowledge = makeDelete('dineai_knowledge');
const upsertDineaiRtSession = makeUpsert('dineai_realtime_sessions', dineaiRtSessionToPgRow, DINEAI_RT_SESSION_JSONB_COLUMNS, dineaiRtSessionToFirestoreObj);
const updateDineaiRtSession = makeUpdate('dineai_realtime_sessions', dineaiRtSessionToPgRow, DINEAI_RT_SESSION_JSONB_COLUMNS);
const upsertDineaiRtFuncCall = makeUpsert('dineai_realtime_function_calls', dineaiRtFuncCallToPgRow, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS, dineaiRtFuncCallToFirestoreObj);
const upsertDineaiCheapSession = makeUpsert('dineai_cheap_sessions', dineaiCheapSessionToPgRow, DINEAI_CHEAP_SESSION_JSONB_COLUMNS, dineaiCheapSessionToFirestoreObj);
const updateDineaiCheapSession = makeUpdate('dineai_cheap_sessions', dineaiCheapSessionToPgRow, DINEAI_CHEAP_SESSION_JSONB_COLUMNS);

// ── AI Usage ─────────────────────────────────────────────────────────────────
const upsertChatgptUsage = makeUpsert('chatgpt_usage', chatgptUsageToPgRow, CHATGPT_USAGE_JSONB_COLUMNS, chatgptUsageToFirestoreObj);
const updateChatgptUsage = makeUpdate('chatgpt_usage', chatgptUsageToPgRow, CHATGPT_USAGE_JSONB_COLUMNS);
const upsertAiUsage = makeUpsert('ai_usage', aiUsageToPgRow, AI_USAGE_JSONB_COLUMNS, aiUsageToFirestoreObj);
const updateAiUsage = makeUpdate('ai_usage', aiUsageToPgRow, AI_USAGE_JSONB_COLUMNS);
const upsertAiInsightsUsage = makeUpsert('ai_insights_usage', aiInsightsUsageToPgRow, AI_INSIGHTS_USAGE_JSONB_COLUMNS, aiInsightsUsageToFirestoreObj);
const updateAiInsightsUsage = makeUpdate('ai_insights_usage', aiInsightsUsageToPgRow, AI_INSIGHTS_USAGE_JSONB_COLUMNS);

// ── Google Reviews ───────────────────────────────────────────────────────────
const upsertGoogleReviewSettings = makeUpsert('google_review_settings', googleReviewSettingsToPgRow, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS, googleReviewSettingsToFirestoreObj);
const updateGoogleReviewSettings = makeUpdate('google_review_settings', googleReviewSettingsToPgRow, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS);
const upsertGoogleReviewsCache = makeUpsert('google_reviews_cache', googleReviewsCacheToPgRow, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS, googleReviewsCacheToFirestoreObj);
const deleteGoogleReviewsCache = makeDelete('google_reviews_cache');
const upsertGoogleBizTokens = makeUpsert('google_business_tokens', googleBizTokensToPgRow, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS, googleBizTokensToFirestoreObj);
const updateGoogleBizTokens = makeUpdate('google_business_tokens', googleBizTokensToPgRow, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS);
const deleteGoogleBizTokens = makeDelete('google_business_tokens');

// ── WhatsApp ─────────────────────────────────────────────────────────────────
const upsertWhatsappConfig = makeUpsert('whatsapp_ordering_config', whatsappConfigToPgRow, WHATSAPP_CONFIG_JSONB_COLUMNS, whatsappConfigToFirestoreObj);
const updateWhatsappConfig = makeUpdate('whatsapp_ordering_config', whatsappConfigToPgRow, WHATSAPP_CONFIG_JSONB_COLUMNS);
const upsertWhatsappLog = makeUpsert('whatsapp_conversation_logs', whatsappLogToPgRow, WHATSAPP_LOG_JSONB_COLUMNS, whatsappLogToFirestoreObj);

// ── Automations ──────────────────────────────────────────────────────────────
const upsertAutomation = makeUpsert('automations', automationToPgRow, AUTOMATION_JSONB_COLUMNS, automationToFirestoreObj);
const updateAutomation = makeUpdate('automations', automationToPgRow, AUTOMATION_JSONB_COLUMNS);
const deleteAutomation = makeDelete('automations');
const upsertAutomationTemplate = makeUpsert('automation_templates', automationTemplateToPgRow, AUTOMATION_TEMPLATE_JSONB_COLUMNS, automationTemplateToFirestoreObj);
const updateAutomationTemplate = makeUpdate('automation_templates', automationTemplateToPgRow, AUTOMATION_TEMPLATE_JSONB_COLUMNS);
const deleteAutomationTemplate = makeDelete('automation_templates');
const upsertAutomationSettings = makeUpsert('automation_settings', automationSettingsToPgRow, AUTOMATION_SETTINGS_JSONB_COLUMNS, automationSettingsToFirestoreObj);
const updateAutomationSettings = makeUpdate('automation_settings', automationSettingsToPgRow, AUTOMATION_SETTINGS_JSONB_COLUMNS);
const upsertAutomationLog = makeUpsert('automation_logs', automationLogToPgRow, AUTOMATION_LOG_JSONB_COLUMNS, automationLogToFirestoreObj);

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Bolna
  upsertBolnaAgent, updateBolnaAgent,
  upsertPhoneCall,
  // DineAI
  upsertDineaiSettings, updateDineaiSettings,
  upsertDineaiUsage, updateDineaiUsage,
  upsertDineaiKnowledge, deleteDineaiKnowledge,
  upsertDineaiRtSession, updateDineaiRtSession,
  upsertDineaiRtFuncCall,
  upsertDineaiCheapSession, updateDineaiCheapSession,
  // AI Usage
  upsertChatgptUsage, updateChatgptUsage,
  upsertAiUsage, updateAiUsage,
  upsertAiInsightsUsage, updateAiInsightsUsage,
  // Google Reviews
  upsertGoogleReviewSettings, updateGoogleReviewSettings,
  upsertGoogleReviewsCache, deleteGoogleReviewsCache,
  upsertGoogleBizTokens, updateGoogleBizTokens, deleteGoogleBizTokens,
  // WhatsApp
  upsertWhatsappConfig, updateWhatsappConfig,
  upsertWhatsappLog,
  // Automations
  upsertAutomation, updateAutomation, deleteAutomation,
  upsertAutomationTemplate, updateAutomationTemplate, deleteAutomationTemplate,
  upsertAutomationSettings, updateAutomationSettings,
  upsertAutomationLog,
};
