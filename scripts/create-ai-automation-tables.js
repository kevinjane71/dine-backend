/**
 * create-ai-automation-tables.js — Create 20 PG tables for Phase 9 AI/Automation/Misc collections.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/create-ai-automation-tables.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- bolna_agents (doc ID = restaurantId)
CREATE TABLE IF NOT EXISTS bolna_agents (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  bolna_agent_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  language TEXT DEFAULT '',
  voice TEXT DEFAULT '',
  greeting TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  capabilities JSONB DEFAULT '[]',
  phone_number TEXT DEFAULT '',
  phone_number_id TEXT DEFAULT '',
  telephony_provider TEXT DEFAULT '',
  call_stats JSONB DEFAULT '{}',
  connected_providers JSONB DEFAULT '{}',
  preferred_provider TEXT DEFAULT '',
  last_menu_sync TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bolna_agents_restaurant ON bolna_agents (restaurant_id);

-- phone_calls
CREATE TABLE IF NOT EXISTS phone_calls (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  bolna_execution_id TEXT DEFAULT '',
  status TEXT DEFAULT '',
  caller_number TEXT DEFAULT '',
  duration NUMERIC(10,2),
  transcript TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  recording_url TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_calls_restaurant ON phone_calls (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_phone_calls_restaurant_created ON phone_calls (restaurant_id, created_at DESC);

-- dineai_settings (doc ID = restaurantId)
CREATE TABLE IF NOT EXISTS dineai_settings (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT false,
  default_voice TEXT DEFAULT '',
  voice_mode TEXT DEFAULT '',
  response_mode TEXT DEFAULT '',
  enable_knowledge_base BOOLEAN DEFAULT false,
  enable_greetings BOOLEAN DEFAULT false,
  greeting_style TEXT DEFAULT '',
  max_session_duration INTEGER,
  features JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);

-- dineai_usage (doc ID = userId_restaurantId_dateStr)
CREATE TABLE IF NOT EXISTS dineai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  date TEXT DEFAULT '',
  count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dineai_usage_user_rest ON dineai_usage (user_id, restaurant_id);

-- dineai_knowledge (doc ID = restaurantId_documentId)
CREATE TABLE IF NOT EXISTS dineai_knowledge (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  document_id TEXT DEFAULT '',
  title TEXT DEFAULT '',
  type TEXT DEFAULT '',
  category TEXT DEFAULT '',
  source TEXT DEFAULT '',
  tags JSONB DEFAULT '[]',
  chunk_count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dineai_knowledge_restaurant ON dineai_knowledge (restaurant_id);

-- dineai_realtime_sessions
CREATE TABLE IF NOT EXISTS dineai_realtime_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  user_role TEXT DEFAULT '',
  voice_mode TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dineai_rt_sessions_restaurant ON dineai_realtime_sessions (restaurant_id);

-- dineai_realtime_function_calls (flattened subcollection)
CREATE TABLE IF NOT EXISTS dineai_realtime_function_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT DEFAULT '',
  function_name TEXT DEFAULT '',
  args JSONB DEFAULT '{}',
  success BOOLEAN DEFAULT false,
  extra_data JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dineai_rt_func_calls_session ON dineai_realtime_function_calls (session_id);

-- dineai_cheap_sessions
CREATE TABLE IF NOT EXISTS dineai_cheap_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  user_role TEXT DEFAULT '',
  voice_mode TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dineai_cheap_sessions_restaurant ON dineai_cheap_sessions (restaurant_id);

-- chatgpt_usage (doc IDs: userId_date or ip_ipAddr_date)
CREATE TABLE IF NOT EXISTS chatgpt_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  ip_address TEXT DEFAULT '',
  date TEXT DEFAULT '',
  call_count INTEGER DEFAULT 0,
  total_tokens_used INTEGER DEFAULT 0,
  last_call_at TIMESTAMPTZ,
  ip_addresses JSONB DEFAULT '[]',
  user_ids JSONB DEFAULT '[]',
  type TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chatgpt_usage_user ON chatgpt_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_chatgpt_usage_date ON chatgpt_usage (date);

-- ai_usage (doc ID = userId)
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  credits_used NUMERIC(12,2) DEFAULT 0,
  credits_month TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- ai_insights_usage (doc ID = userId)
CREATE TABLE IF NOT EXISTS ai_insights_usage (
  id TEXT PRIMARY KEY,
  date TEXT DEFAULT '',
  count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- google_review_settings (doc ID = restaurantId)
CREATE TABLE IF NOT EXISTS google_review_settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  google_review_url TEXT DEFAULT '',
  ai_enabled BOOLEAN DEFAULT false,
  custom_message TEXT DEFAULT '',
  qr_code_url TEXT DEFAULT '',
  google_account_connected BOOLEAN DEFAULT false,
  connected_email TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_review_settings_restaurant ON google_review_settings (restaurant_id);

-- google_reviews_cache (doc ID = restaurantId, 5-min TTL cache)
CREATE TABLE IF NOT EXISTS google_reviews_cache (
  id TEXT PRIMARY KEY,
  response JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- google_business_tokens (doc ID = restaurantId, contains OAuth tokens)
CREATE TABLE IF NOT EXISTS google_business_tokens (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  expires_at TIMESTAMPTZ,
  user_id TEXT DEFAULT '',
  connected_email TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  connected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_google_biz_tokens_restaurant ON google_business_tokens (restaurant_id);

-- whatsapp_ordering_config (doc ID = restaurantId)
CREATE TABLE IF NOT EXISTS whatsapp_ordering_config (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  phone_number_id TEXT DEFAULT '',
  business_account_id TEXT DEFAULT '',
  webhook_verify_token TEXT DEFAULT '',
  greeting TEXT DEFAULT '',
  menu_header TEXT DEFAULT '',
  payment_mode TEXT DEFAULT '',
  payment_link TEXT DEFAULT '',
  auto_accept_orders BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT false,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_restaurant ON whatsapp_ordering_config (restaurant_id);

-- whatsapp_conversation_logs
CREATE TABLE IF NOT EXISTS whatsapp_conversation_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  incoming_type TEXT DEFAULT '',
  incoming_text TEXT DEFAULT '',
  interactive_id TEXT DEFAULT '',
  response_count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_restaurant ON whatsapp_conversation_logs (restaurant_id);

-- automations
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  trigger JSONB DEFAULT '{}',
  action JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT false,
  stats JSONB DEFAULT '{}',
  last_triggered TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automations_restaurant ON automations (restaurant_id);

-- automation_templates
CREATE TABLE IF NOT EXISTS automation_templates (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  trigger JSONB DEFAULT '{}',
  action JSONB DEFAULT '{}',
  category TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_templates_restaurant ON automation_templates (restaurant_id);

-- automation_settings (contains WhatsApp/email credentials)
CREATE TABLE IF NOT EXISTS automation_settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  type TEXT DEFAULT '',
  mode TEXT DEFAULT '',
  connected BOOLEAN DEFAULT false,
  access_token TEXT DEFAULT '',
  phone_number_id TEXT DEFAULT '',
  business_account_id TEXT DEFAULT '',
  webhook_verify_token TEXT DEFAULT '',
  phone_number TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_settings_restaurant ON automation_settings (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_automation_settings_restaurant_type ON automation_settings (restaurant_id, type);

-- automation_logs (dual purpose: automation trigger logs + WhatsApp conversation messages)
CREATE TABLE IF NOT EXISTS automation_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  automation_id TEXT DEFAULT '',
  type TEXT DEFAULT '',
  trigger_type TEXT DEFAULT '',
  customer_id TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  message TEXT DEFAULT '',
  message_id TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  amount NUMERIC(12,2),
  direction TEXT DEFAULT '',
  status TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_logs_restaurant ON automation_logs (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_restaurant_type ON automation_logs (restaurant_id, type);
CREATE INDEX IF NOT EXISTS idx_automation_logs_restaurant_timestamp ON automation_logs (restaurant_id, timestamp DESC);
`;

async function main() {
  try {
    console.log('Creating 20 AI/Automation/Misc tables...');
    await query(DDL);
    console.log('All 20 AI/Automation tables created successfully.');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
