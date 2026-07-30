--
-- PostgreSQL database dump
--

\restrict GF6xWoXrEeJT0EtN9rTp2o9ODlBiMNdOkVQIgLuSEHB6sL2RVg3dDLrq9nKAwWn

-- Dumped from database version 15.18
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: daily_stats_merge_array(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.daily_stats_merge_array(existing jsonb, new_data jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF existing IS NULL OR existing = '[]'::jsonb THEN RETURN COALESCE(new_data, '[]'::jsonb); END IF;
  IF new_data IS NULL OR new_data = '[]'::jsonb THEN RETURN existing; END IF;
  
  RETURN (
    SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements(existing) AS elem
      UNION
      SELECT jsonb_array_elements(new_data) AS elem
    ) combined
  );
END;
$$;


--
-- Name: daily_stats_merge_jsonb(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.daily_stats_merge_jsonb(existing jsonb, new_data jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  key TEXT;
  result JSONB;
  existing_val JSONB;
  new_val JSONB;
BEGIN
  IF existing IS NULL OR existing = '{}'::jsonb THEN RETURN COALESCE(new_data, '{}'::jsonb); END IF;
  IF new_data IS NULL OR new_data = '{}'::jsonb THEN RETURN existing; END IF;
  
  result := existing;
  FOR key IN SELECT jsonb_object_keys(new_data) LOOP
    new_val := new_data -> key;
    existing_val := result -> key;
    
    IF existing_val IS NULL THEN
      -- Key doesn't exist yet, just set it
      result := jsonb_set(result, ARRAY[key], new_val);
    ELSIF jsonb_typeof(existing_val) = 'number' AND jsonb_typeof(new_val) = 'number' THEN
      -- Both numbers: add them
      result := jsonb_set(result, ARRAY[key], to_jsonb((existing_val::text)::numeric + (new_val::text)::numeric));
    ELSIF jsonb_typeof(existing_val) = 'object' AND jsonb_typeof(new_val) = 'object' THEN
      -- Both objects: recurse
      result := jsonb_set(result, ARRAY[key], daily_stats_merge_jsonb(existing_val, new_val));
    ELSE
      -- Different types: new value wins
      result := jsonb_set(result, ARRAY[key], new_val);
    END IF;
  END LOOP;
  
  RETURN result;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_tasks (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: aggregator_webhook_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregator_webhook_logs (
    id text NOT NULL,
    source text DEFAULT ''::text,
    event text DEFAULT ''::text,
    payload jsonb DEFAULT '{}'::jsonb,
    signature text DEFAULT ''::text,
    "timestamp" timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    user_id text DEFAULT ''::text,
    query text DEFAULT ''::text,
    response text DEFAULT ''::text,
    intent text DEFAULT ''::text,
    action text DEFAULT ''::text,
    "timestamp" timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: ai_insights_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_insights_usage (
    id text NOT NULL,
    date text DEFAULT ''::text,
    count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    credits_used numeric DEFAULT 0,
    credits_month text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id text NOT NULL,
    email text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    name text DEFAULT ''::text,
    password text DEFAULT ''::text,
    role text DEFAULT 'owner'::text,
    email_verified boolean DEFAULT false,
    phone_verified boolean DEFAULT false,
    provider text DEFAULT ''::text,
    setup_complete boolean DEFAULT false,
    google_uid text DEFAULT ''::text,
    apple_uid text DEFAULT ''::text,
    firebase_uid text DEFAULT ''::text,
    photo_url text DEFAULT ''::text,
    picture text DEFAULT ''::text,
    temporary_password boolean DEFAULT false,
    restaurant_name text DEFAULT ''::text,
    login_id text DEFAULT ''::text,
    username text DEFAULT ''::text,
    username_lower text DEFAULT ''::text,
    created_by text DEFAULT ''::text,
    created_by_role text DEFAULT ''::text,
    last_login timestamp with time zone,
    last_login_platform text DEFAULT ''::text,
    pin_hash text DEFAULT ''::text,
    pin_enabled boolean DEFAULT false,
    pin_updated_at timestamp with time zone,
    pin_attempts integer DEFAULT 0,
    pin_locked_until timestamp with time zone,
    tip_earnings numeric DEFAULT 0,
    admin_note text DEFAULT ''::text,
    admin_note_updated_at timestamp with time zone,
    tip_history jsonb DEFAULT '[]'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    default_restaurant_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    language text DEFAULT 'en'::text,
    email_otp text,
    email_otp_expiry timestamp with time zone
);


--
-- Name: attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance (
    id text NOT NULL,
    staff_id text NOT NULL,
    staff_name text,
    role text,
    restaurant_id text NOT NULL,
    date text,
    status text,
    clock_in text,
    clock_out text,
    clock_in_location jsonb,
    clock_out_location jsonb,
    total_hours numeric,
    late_by integer DEFAULT 0,
    overtime_hours numeric DEFAULT 0,
    early_leave_by integer DEFAULT 0,
    leave_type text,
    leave_request_id text,
    is_half_day boolean DEFAULT false,
    notes text,
    manual_entry boolean DEFAULT false,
    entered_by text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: automation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_logs (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    automation_id text DEFAULT ''::text,
    type text DEFAULT ''::text,
    trigger_type text DEFAULT ''::text,
    customer_id text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    contact_name text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    message text DEFAULT ''::text,
    message_id text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    amount numeric,
    direction text DEFAULT ''::text,
    status text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    "timestamp" timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: automation_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_settings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    type text DEFAULT ''::text,
    mode text DEFAULT ''::text,
    connected boolean DEFAULT false,
    access_token text DEFAULT ''::text,
    phone_number_id text DEFAULT ''::text,
    business_account_id text DEFAULT ''::text,
    webhook_verify_token text DEFAULT ''::text,
    phone_number text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: automation_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_templates (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    description text DEFAULT ''::text,
    trigger jsonb DEFAULT '{}'::jsonb,
    action jsonb DEFAULT '{}'::jsonb,
    category text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automations (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    trigger jsonb DEFAULT '{}'::jsonb,
    action jsonb DEFAULT '{}'::jsonb,
    enabled boolean DEFAULT false,
    stats jsonb DEFAULT '{}'::jsonb,
    last_triggered timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bar_bottles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bar_bottles (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    inventory_item_id text,
    menu_item_id text,
    barcode text,
    name text,
    brand text,
    category text,
    category_id text,
    bottle_size numeric,
    peg_size numeric,
    full_weight numeric,
    tare_weight numeric,
    opening_weight numeric,
    current_weight numeric,
    closing_weight numeric,
    status text DEFAULT 'sealed'::text,
    opened_at timestamp with time zone,
    opened_by text,
    empty_at timestamp with time zone,
    total_pegs_expected numeric,
    total_pegs_poured numeric DEFAULT 0,
    total_ml_poured numeric DEFAULT 0,
    total_ml_sold numeric DEFAULT 0,
    wastage numeric DEFAULT 0,
    wastage_entries jsonb DEFAULT '[]'::jsonb,
    batch_id text,
    cost_price numeric,
    ml_per_gram numeric DEFAULT 1.0,
    created_by text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bar_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bar_reconciliation (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    date text,
    shift text,
    status text DEFAULT 'open'::text,
    opening_snapshot jsonb DEFAULT '[]'::jsonb,
    closing_snapshot jsonb DEFAULT '[]'::jsonb,
    total_ml_consumed numeric DEFAULT 0,
    total_ml_sold numeric DEFAULT 0,
    total_variance numeric DEFAULT 0,
    total_variance_value numeric DEFAULT 0,
    opened_at timestamp with time zone,
    opened_by text,
    closed_at timestamp with time zone,
    closed_by text,
    notes text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: blocked_ips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_ips (
    id text NOT NULL,
    ip text DEFAULT ''::text,
    blocked_until timestamp with time zone,
    blocked_at timestamp with time zone,
    reason text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: bolna_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bolna_agents (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    bolna_agent_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    language text DEFAULT ''::text,
    voice text DEFAULT ''::text,
    greeting text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    capabilities jsonb DEFAULT '[]'::jsonb,
    phone_number text DEFAULT ''::text,
    phone_number_id text DEFAULT ''::text,
    telephony_provider text DEFAULT ''::text,
    call_stats jsonb DEFAULT '{}'::jsonb,
    connected_providers jsonb DEFAULT '{}'::jsonb,
    preferred_provider text DEFAULT ''::text,
    last_menu_sync timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);


--
-- Name: booking_venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_venues (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text,
    capacity integer DEFAULT 0,
    description text,
    hourly_rate numeric,
    fixed_rate numeric,
    operating_hours jsonb,
    allow_multiple_bookings boolean DEFAULT false,
    max_concurrent_bookings integer DEFAULT 1,
    amenities jsonb DEFAULT '[]'::jsonb,
    sections jsonb,
    is_active boolean DEFAULT true,
    status text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: bookings_v2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings_v2 (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    booking_number text,
    type text,
    customer jsonb,
    event_name text,
    event_date text,
    event_end_date text,
    event_time text,
    event_end_time text,
    guest_count integer DEFAULT 0,
    special_instructions text,
    venue jsonb,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    discount jsonb,
    tax_amount numeric DEFAULT 0,
    service_charge numeric DEFAULT 0,
    total_amount numeric DEFAULT 0,
    payments jsonb DEFAULT '[]'::jsonb,
    paid_amount numeric DEFAULT 0,
    balance_amount numeric DEFAULT 0,
    payment_status text DEFAULT 'unpaid'::text,
    status text DEFAULT 'confirmed'::text,
    track_expense boolean DEFAULT false,
    expense_created boolean DEFAULT false,
    created_by jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason text
);


--
-- Name: cash_registers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_registers (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    organization_id text,
    opening_cash numeric DEFAULT 0,
    opened_by text,
    opened_by_name text,
    operator_name text,
    opened_at timestamp with time zone,
    opening_notes text,
    status text DEFAULT 'open'::text,
    transactions jsonb DEFAULT '[]'::jsonb,
    cash_in numeric DEFAULT 0,
    cash_out numeric DEFAULT 0,
    cash_drops numeric DEFAULT 0,
    closing_cash numeric,
    closed_by text,
    closed_by_name text,
    closed_at timestamp with time zone,
    closing_notes text,
    denominations jsonb,
    total_sales numeric,
    cash_sales numeric,
    card_sales numeric,
    upi_sales numeric,
    aggregator_sales numeric,
    other_sales numeric,
    order_count integer,
    total_tips numeric,
    cash_tips numeric,
    card_tips numeric,
    service_charge_collected numeric,
    expected_cash numeric,
    cash_difference numeric,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: chart_of_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chart_of_accounts (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    code text,
    name text,
    type text,
    parent_code text,
    is_system boolean DEFAULT false,
    balance numeric DEFAULT 0,
    description text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: chatbot_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chatbot_conversations (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    messages jsonb DEFAULT '[]'::jsonb,
    last_message text DEFAULT ''::text,
    last_response text DEFAULT ''::text,
    function_called text DEFAULT ''::text,
    "timestamp" timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: chatgpt_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chatgpt_usage (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    ip_address text DEFAULT ''::text,
    date text DEFAULT ''::text,
    call_count integer DEFAULT 0,
    total_tokens_used integer DEFAULT 0,
    last_call_at timestamp with time zone,
    ip_addresses jsonb DEFAULT '[]'::jsonb,
    user_ids jsonb DEFAULT '[]'::jsonb,
    type text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupons (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    code text DEFAULT ''::text,
    type text DEFAULT ''::text,
    value numeric DEFAULT 0,
    min_order_amount numeric DEFAULT 0,
    max_uses integer DEFAULT 0,
    used_count integer DEFAULT 0,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    is_active boolean DEFAULT true,
    is_public boolean DEFAULT false,
    applicable_to text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: customer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_groups (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    description text DEFAULT ''::text,
    color text DEFAULT ''::text,
    icon text DEFAULT ''::text,
    customer_ids jsonb DEFAULT '[]'::jsonb,
    customer_phones jsonb DEFAULT '[]'::jsonb,
    customer_count integer DEFAULT 0,
    created_by text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: customer_offer_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_offer_usage (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    offer_id text NOT NULL,
    customer_key text NOT NULL,
    usage_count integer DEFAULT 0,
    first_used_at timestamp with time zone,
    last_used_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    customer_id text,
    firebase_uid text,
    name text,
    phone text,
    email text,
    city text,
    dob text,
    address text,
    locality text,
    anniversary text,
    gst_number text,
    source text,
    do_not_contact boolean DEFAULT false,
    whatsapp_bill_enabled boolean DEFAULT true,
    total_orders integer DEFAULT 0,
    total_spent numeric DEFAULT 0,
    last_order_date timestamp with time zone,
    order_history jsonb DEFAULT '[]'::jsonb,
    loyalty_points numeric DEFAULT 0,
    lifetime_points numeric DEFAULT 0,
    loyalty_tier text DEFAULT 'bronze'::text,
    loyalty_transactions jsonb DEFAULT '[]'::jsonb,
    outstanding_balance numeric DEFAULT 0,
    credit_history jsonb DEFAULT '[]'::jsonb,
    settlement_history jsonb DEFAULT '[]'::jsonb,
    wallet_balance numeric DEFAULT 0,
    wallet_history jsonb DEFAULT '[]'::jsonb,
    tip_earnings numeric DEFAULT 0,
    tip_history jsonb DEFAULT '[]'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    wallet_card_number text,
    wallet_card_barcode text
);


--
-- Name: d365_sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.d365_sync_log (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    type text DEFAULT ''::text,
    date text DEFAULT ''::text,
    status text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    journal_lines_posted integer DEFAULT 0,
    total_amount numeric DEFAULT 0,
    bc_document_number text DEFAULT ''::text,
    items_synced integer DEFAULT 0,
    customers_synced integer DEFAULT 0,
    error text,
    details jsonb DEFAULT '{}'::jsonb,
    synced_by text DEFAULT ''::text,
    synced_at timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: daily_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_stats (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    date text NOT NULL,
    sub_restaurant_id text,
    sub_restaurant_name text,
    total_orders integer DEFAULT 0,
    total_revenue numeric DEFAULT 0,
    total_revenue_with_tax numeric DEFAULT 0,
    total_due_amount numeric DEFAULT 0,
    total_tax numeric DEFAULT 0,
    total_discounts numeric DEFAULT 0,
    total_refunds numeric DEFAULT 0,
    hour_00 integer DEFAULT 0,
    hour_01 integer DEFAULT 0,
    hour_02 integer DEFAULT 0,
    hour_03 integer DEFAULT 0,
    hour_04 integer DEFAULT 0,
    hour_05 integer DEFAULT 0,
    hour_06 integer DEFAULT 0,
    hour_07 integer DEFAULT 0,
    hour_08 integer DEFAULT 0,
    hour_09 integer DEFAULT 0,
    hour_10 integer DEFAULT 0,
    hour_11 integer DEFAULT 0,
    hour_12 integer DEFAULT 0,
    hour_13 integer DEFAULT 0,
    hour_14 integer DEFAULT 0,
    hour_15 integer DEFAULT 0,
    hour_16 integer DEFAULT 0,
    hour_17 integer DEFAULT 0,
    hour_18 integer DEFAULT 0,
    hour_19 integer DEFAULT 0,
    hour_20 integer DEFAULT 0,
    hour_21 integer DEFAULT 0,
    hour_22 integer DEFAULT 0,
    hour_23 integer DEFAULT 0,
    payment_methods jsonb DEFAULT '{}'::jsonb,
    order_types jsonb DEFAULT '{}'::jsonb,
    item_counts jsonb DEFAULT '{}'::jsonb,
    category_breakdown jsonb DEFAULT '{}'::jsonb,
    customer_ids jsonb DEFAULT '[]'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    total_covers numeric DEFAULT 0,
    refunds_issued numeric DEFAULT 0
);


--
-- Name: demo_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_requests (
    id text NOT NULL,
    contact_type text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    email text DEFAULT ''::text,
    restaurant_name text DEFAULT ''::text,
    comment text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    ip_address text DEFAULT ''::text,
    user_agent text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: desktop_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desktop_auth_sessions (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_dodo_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_dodo_billing (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    type text DEFAULT ''::text,
    session_id text DEFAULT ''::text,
    plan_id text DEFAULT ''::text,
    previous_plan_id text DEFAULT ''::text,
    product_id text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    app text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_dodo_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_dodo_disputes (
    id text NOT NULL,
    type text DEFAULT ''::text,
    dispute_id text DEFAULT ''::text,
    payment_id text DEFAULT ''::text,
    amount numeric DEFAULT 0,
    reason text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_dodo_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_dodo_orders (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    session_id text DEFAULT ''::text,
    plan_id text DEFAULT ''::text,
    product_id text DEFAULT ''::text,
    checkout_url text DEFAULT ''::text,
    email text DEFAULT ''::text,
    name text DEFAULT ''::text,
    payment_gateway text DEFAULT ''::text,
    app text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_dodo_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_dodo_refunds (
    id text NOT NULL,
    type text DEFAULT ''::text,
    refund_id text DEFAULT ''::text,
    payment_id text DEFAULT ''::text,
    amount numeric DEFAULT 0,
    reason text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_dodo_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_dodo_webhook_events (
    id text NOT NULL,
    event_type text DEFAULT ''::text,
    event_id text DEFAULT ''::text,
    payload jsonb DEFAULT '{}'::jsonb,
    processed_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_orders (
    id text NOT NULL,
    order_id text,
    amount numeric,
    currency text DEFAULT 'INR'::text,
    plan_id text,
    email text,
    user_id text,
    phone text,
    shop_id text,
    app text,
    status text DEFAULT 'created'::text,
    payment_id text,
    payment_status text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_payments (
    id text NOT NULL,
    subscription_id text,
    order_id text,
    payment_id text,
    signature text,
    plan_id text,
    email text,
    user_id text,
    phone text,
    shop_id text,
    amount numeric,
    currency text DEFAULT 'INR'::text,
    app text DEFAULT 'Dine'::text,
    status text,
    type text,
    verified_at timestamp with time zone,
    webhook_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    method text,
    synced_from_razorpay boolean
);


--
-- Name: dine_razorpay_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_razorpay_orders (
    id text NOT NULL,
    order_id text,
    amount numeric,
    currency text DEFAULT 'INR'::text,
    plan_id text,
    email text,
    user_id text,
    phone text,
    shop_id text,
    app text DEFAULT 'Dine'::text,
    status text,
    payment_id text,
    synced_from_razorpay boolean DEFAULT false,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_subscriptions (
    id text NOT NULL,
    subscription_id text,
    razorpay_plan_id text,
    plan_id text,
    email text,
    user_id text,
    phone text,
    shop_id text,
    app text DEFAULT 'Dine'::text,
    status text,
    payment_id text,
    activated_at timestamp with time zone,
    last_charged_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    completed_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dine_user_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_user_data (
    id text NOT NULL,
    uid text DEFAULT ''::text,
    email text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    role text DEFAULT 'owner'::text,
    app text DEFAULT 'Dine'::text,
    subscription jsonb DEFAULT '{}'::jsonb,
    restaurant_info jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: dine_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dine_webhook_events (
    id text NOT NULL,
    full_payload jsonb DEFAULT '{}'::jsonb,
    webhook_received_at timestamp with time zone,
    event text DEFAULT ''::text,
    app text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: dineai_cheap_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_cheap_sessions (
    id text NOT NULL,
    session_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    user_id text DEFAULT ''::text,
    user_role text DEFAULT ''::text,
    voice_mode text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    message_count integer DEFAULT 0,
    last_message_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone
);


--
-- Name: dineai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_conversations (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dineai_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_knowledge (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    document_id text DEFAULT ''::text,
    title text DEFAULT ''::text,
    type text DEFAULT ''::text,
    category text DEFAULT ''::text,
    source text DEFAULT ''::text,
    tags jsonb DEFAULT '[]'::jsonb,
    chunk_count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dineai_realtime_function_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_realtime_function_calls (
    id text NOT NULL,
    session_id text DEFAULT ''::text,
    function_name text DEFAULT ''::text,
    args jsonb DEFAULT '{}'::jsonb,
    success boolean DEFAULT false,
    extra_data jsonb DEFAULT '{}'::jsonb,
    "timestamp" timestamp with time zone DEFAULT now()
);


--
-- Name: dineai_realtime_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_realtime_sessions (
    id text NOT NULL,
    session_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    user_id text DEFAULT ''::text,
    user_role text DEFAULT ''::text,
    voice_mode text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone
);


--
-- Name: dineai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_settings (
    id text NOT NULL,
    enabled boolean DEFAULT false,
    default_voice text DEFAULT ''::text,
    voice_mode text DEFAULT ''::text,
    response_mode text DEFAULT ''::text,
    enable_knowledge_base boolean DEFAULT false,
    enable_greetings boolean DEFAULT false,
    greeting_style text DEFAULT ''::text,
    max_session_duration integer,
    features jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by text DEFAULT ''::text
);


--
-- Name: dineai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dineai_usage (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    date text DEFAULT ''::text,
    count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: discount_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_approvals (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    requested_by text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    discount_percent numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    reason text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    approved_by text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: discount_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_settings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    max_discount_percent numeric DEFAULT 0,
    require_approval boolean DEFAULT false,
    approval_threshold numeric DEFAULT 0,
    allowed_roles jsonb DEFAULT '[]'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: distribution_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distribution_plans (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    production_order_id text,
    central_kitchen_id text,
    item_name text DEFAULT ''::text,
    total_quantity numeric DEFAULT 0,
    unit text DEFAULT ''::text,
    allocations jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'draft'::text,
    created_by text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: email_otp_temp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_otp_temp (
    id text NOT NULL,
    email text DEFAULT ''::text,
    otp text DEFAULT ''::text,
    otp_expiry timestamp with time zone,
    purpose text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ent_organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ent_organizations (
    id text NOT NULL,
    name text DEFAULT ''::text,
    type text DEFAULT 'chain'::text,
    owner_id text DEFAULT ''::text,
    settings jsonb DEFAULT '{}'::jsonb,
    outlets jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    category text,
    sub_categories jsonb,
    amount numeric,
    date timestamp with time zone,
    description text,
    payment_method text,
    receipt_url text,
    is_recurring boolean DEFAULT false,
    recurring_frequency text,
    vendor text,
    created_by text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: feedback_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback_forms (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    title text DEFAULT ''::text,
    fields jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'active'::text,
    response_count integer DEFAULT 0,
    thank_you_message text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    distribution jsonb
);


--
-- Name: feedback_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback_responses (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    form_id text DEFAULT ''::text,
    responses jsonb DEFAULT '{}'::jsonb,
    rating numeric,
    customer_name text DEFAULT ''::text,
    customer_phone text DEFAULT ''::text,
    submitted_at timestamp with time zone DEFAULT now(),
    order_id text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: floors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.floors (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    section text,
    area_charge_type text DEFAULT 'none'::text,
    area_charge_value numeric DEFAULT 0,
    sort_order integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: goods_receipt_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goods_receipt_notes (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    purchase_order_id text DEFAULT ''::text,
    supplier_id text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    received_date timestamp with time zone,
    received_by text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: google_business_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_business_tokens (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    access_token text DEFAULT ''::text,
    refresh_token text DEFAULT ''::text,
    expires_at timestamp with time zone,
    user_id text DEFAULT ''::text,
    connected_email text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    connected_at timestamp with time zone
);


--
-- Name: google_review_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_review_settings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    google_review_url text DEFAULT ''::text,
    ai_enabled boolean DEFAULT false,
    custom_message text DEFAULT ''::text,
    qr_code_url text DEFAULT ''::text,
    google_account_connected boolean DEFAULT false,
    connected_email text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: google_reviews_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_reviews_cache (
    id text NOT NULL,
    response jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    cached_at timestamp with time zone DEFAULT now()
);


--
-- Name: hotel_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hotel_bookings (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    room_id text,
    room_number text,
    guest_name text,
    guest_phone text,
    guest_email text,
    check_in_date text,
    check_out_date text,
    number_of_guests integer DEFAULT 1,
    stay_duration integer DEFAULT 0,
    estimated_tariff numeric DEFAULT 0,
    total_amount numeric DEFAULT 0,
    special_requests text,
    booking_source text DEFAULT 'front-desk'::text,
    status text DEFAULT 'confirmed'::text,
    unavailable_override boolean DEFAULT false,
    cancellation_reason text,
    cancelled_at timestamp with time zone,
    cancelled_by text,
    check_in_id text,
    checked_out_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: hotel_checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hotel_checkins (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    guest_id text,
    room_id text,
    room_number text,
    guest_name text,
    guest_phone text,
    guest_email text,
    check_in_date timestamp with time zone,
    check_out_date timestamp with time zone,
    stay_duration integer DEFAULT 0,
    number_of_guests integer DEFAULT 1,
    room_tariff numeric DEFAULT 0,
    total_room_charges numeric DEFAULT 0,
    advance_payment numeric DEFAULT 0,
    payment_mode text DEFAULT 'cash'::text,
    special_requests text,
    status text DEFAULT 'checked-in'::text,
    food_orders jsonb DEFAULT '[]'::jsonb,
    total_food_charges numeric DEFAULT 0,
    total_charges numeric DEFAULT 0,
    balance_amount numeric DEFAULT 0,
    id_proof jsonb,
    gst_info jsonb,
    check_in_by text,
    check_in_at timestamp with time zone,
    actual_check_out_at timestamp with time zone,
    final_payment numeric DEFAULT 0,
    final_payment_mode text,
    discounts jsonb DEFAULT '[]'::jsonb,
    discount_amount numeric DEFAULT 0,
    additional_charges jsonb DEFAULT '[]'::jsonb,
    total_paid numeric DEFAULT 0,
    checkout_notes text,
    check_out_by text,
    billing_complete boolean DEFAULT false,
    booking_id text,
    last_updated timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: hotel_guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hotel_guests (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text,
    phone text,
    email text,
    address text,
    city text,
    state text,
    country text,
    zip_code text,
    id_proof_type text,
    id_proof_number text,
    id_proof_image_url text,
    gst_number text,
    gst_company_name text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    created_by text
);


--
-- Name: hotel_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hotel_rooms (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    room_number text,
    type text DEFAULT 'standard'::text,
    floor text,
    capacity integer DEFAULT 2,
    amenities jsonb DEFAULT '[]'::jsonb,
    tariff numeric DEFAULT 0,
    status text DEFAULT 'available'::text,
    current_guest text,
    check_in_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    response jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


--
-- Name: indent_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indent_requests (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    requesting_outlet_id text DEFAULT ''::text,
    warehouse_id text DEFAULT ''::text,
    indent_number text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    priority text DEFAULT 'medium'::text,
    status text DEFAULT 'requested'::text,
    requested_by text DEFAULT ''::text,
    approved_by text,
    dispatched_by text,
    received_by text,
    requested_at timestamp with time zone,
    approved_at timestamp with time zone,
    dispatched_at timestamp with time zone,
    received_at timestamp with time zone,
    rejection_reason text,
    delivery_notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_challans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_challans (
    id text NOT NULL,
    org_id text NOT NULL,
    customer_id text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    challan_number text DEFAULT ''::text,
    reference_number text DEFAULT ''::text,
    challan_date text DEFAULT ''::text,
    challan_type text DEFAULT 'supply_on_approval'::text,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    adjustments numeric DEFAULT 0,
    total numeric DEFAULT 0,
    status text DEFAULT 'draft'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_customers (
    id text NOT NULL,
    org_id text NOT NULL,
    type text DEFAULT 'business'::text,
    salutation text DEFAULT ''::text,
    first_name text DEFAULT ''::text,
    last_name text DEFAULT ''::text,
    company_name text DEFAULT ''::text,
    display_name text DEFAULT ''::text,
    email text DEFAULT ''::text,
    work_phone text DEFAULT ''::text,
    mobile text DEFAULT ''::text,
    pan text DEFAULT ''::text,
    gstin text DEFAULT ''::text,
    currency text DEFAULT 'INR'::text,
    payment_terms text DEFAULT 'due_on_receipt'::text,
    language text DEFAULT 'English'::text,
    billing_address jsonb DEFAULT '{}'::jsonb,
    shipping_address jsonb DEFAULT '{}'::jsonb,
    contact_persons jsonb DEFAULT '[]'::jsonb,
    notes text DEFAULT ''::text,
    custom_fields jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'active'::text,
    source_app text DEFAULT 'standalone'::text,
    source_ref text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_expenses (
    id text NOT NULL,
    org_id text NOT NULL,
    date text DEFAULT ''::text,
    category text DEFAULT ''::text,
    amount numeric DEFAULT 0,
    currency text DEFAULT 'INR'::text,
    invoice_number text DEFAULT ''::text,
    notes text DEFAULT ''::text,
    customer_id text DEFAULT ''::text,
    receipt text DEFAULT ''::text,
    is_billable boolean DEFAULT false,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_invoices (
    id text NOT NULL,
    org_id text NOT NULL,
    customer_id text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    invoice_number text DEFAULT ''::text,
    reference_number text DEFAULT ''::text,
    invoice_date text DEFAULT ''::text,
    due_date text DEFAULT ''::text,
    payment_terms text DEFAULT 'due_on_receipt'::text,
    salesperson text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    discount_type text DEFAULT 'fixed'::text,
    discount_value numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    tax_amount numeric DEFAULT 0,
    tax_breakdown jsonb DEFAULT '[]'::jsonb,
    adjustments numeric DEFAULT 0,
    total numeric DEFAULT 0,
    paid_amount numeric DEFAULT 0,
    balance_due numeric DEFAULT 0,
    customer_notes text DEFAULT ''::text,
    terms_and_conditions text DEFAULT ''::text,
    attachments jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'draft'::text,
    source_app text DEFAULT 'standalone'::text,
    source_ref text DEFAULT ''::text,
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_items (
    id text NOT NULL,
    org_id text NOT NULL,
    name text DEFAULT ''::text,
    type text DEFAULT 'goods'::text,
    unit text DEFAULT ''::text,
    selling_price numeric DEFAULT 0,
    cost_price numeric DEFAULT 0,
    description text DEFAULT ''::text,
    tax_rate numeric DEFAULT 0,
    tax_type text DEFAULT 'GST'::text,
    hsn_code text DEFAULT ''::text,
    sku text DEFAULT ''::text,
    image text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_number_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_number_sequences (
    id text NOT NULL,
    org_id text NOT NULL,
    type text DEFAULT ''::text,
    prefix text DEFAULT ''::text,
    current_number integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_organizations (
    id text NOT NULL,
    user_id text NOT NULL,
    name text DEFAULT ''::text,
    email text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    address jsonb DEFAULT '{}'::jsonb,
    logo text DEFAULT ''::text,
    gstin text DEFAULT ''::text,
    pan text DEFAULT ''::text,
    currency text DEFAULT 'INR'::text,
    date_format text DEFAULT 'DD/MM/YYYY'::text,
    fiscal_year_start integer DEFAULT 4,
    theme jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_payments (
    id text NOT NULL,
    org_id text NOT NULL,
    customer_id text DEFAULT ''::text,
    invoice_id text DEFAULT ''::text,
    payment_number text DEFAULT ''::text,
    payment_date text DEFAULT ''::text,
    amount numeric DEFAULT 0,
    payment_mode text DEFAULT 'other'::text,
    reference_number text DEFAULT ''::text,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_quotes (
    id text NOT NULL,
    org_id text NOT NULL,
    customer_id text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    quote_number text DEFAULT ''::text,
    reference_number text DEFAULT ''::text,
    quote_date text DEFAULT ''::text,
    expiry_date text DEFAULT ''::text,
    salesperson text DEFAULT ''::text,
    project_name text DEFAULT ''::text,
    subject text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    discount_type text DEFAULT 'fixed'::text,
    discount_value numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    tax_amount numeric DEFAULT 0,
    total numeric DEFAULT 0,
    customer_notes text DEFAULT ''::text,
    terms_and_conditions text DEFAULT ''::text,
    status text DEFAULT 'draft'::text,
    converted_invoice_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inv_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_settings (
    id text NOT NULL,
    org_id text NOT NULL,
    invoice_number_prefix text DEFAULT 'INV-'::text,
    invoice_start_number integer DEFAULT 1,
    quote_number_prefix text DEFAULT 'QT-'::text,
    challan_number_prefix text DEFAULT 'DC-'::text,
    payment_number_prefix text DEFAULT 'PAY-'::text,
    default_payment_terms text DEFAULT 'due_on_receipt'::text,
    default_customer_notes text DEFAULT ''::text,
    default_terms_and_conditions text DEFAULT ''::text,
    tax_settings jsonb DEFAULT '{}'::jsonb,
    pdf_template text DEFAULT 'standard'::text,
    pdf_colors jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text NOT NULL,
    category text,
    unit text,
    current_stock numeric DEFAULT 0,
    min_stock numeric DEFAULT 0,
    max_stock numeric DEFAULT 0,
    cost_per_unit numeric DEFAULT 0,
    supplier text,
    description text,
    barcode text,
    location text,
    status text DEFAULT 'good'::text,
    linked_menu_item_id text,
    linked_menu_item_name text,
    expiry_date timestamp with time zone,
    mfg_date timestamp with time zone,
    expiry_days integer,
    wasted_qty numeric DEFAULT 0,
    created_by text,
    updated_by text,
    last_updated timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inventory_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_categories (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text,
    description text,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: inventory_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_transactions (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    inventory_item_id text,
    inventory_item_name text,
    type text NOT NULL,
    source text,
    quantity_change numeric DEFAULT 0,
    previous_stock numeric,
    new_stock numeric,
    unit text,
    cost_per_unit numeric,
    previous_cost_per_unit numeric,
    total_cost numeric,
    date timestamp with time zone,
    reference_id text,
    batch_ids jsonb DEFAULT '[]'::jsonb,
    performed_by text,
    notes text,
    original_transaction_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    order_id text,
    reversed_at timestamp with time zone,
    reason text
);


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    date timestamp with time zone,
    description text,
    debit_account text,
    debit_account_name text,
    credit_account text,
    credit_account_name text,
    amount numeric,
    reference jsonb,
    created_by text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: leave_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_balances (
    id text NOT NULL,
    staff_id text NOT NULL,
    staff_name text,
    restaurant_id text NOT NULL,
    year integer,
    balances jsonb,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: leave_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_config (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    leave_types jsonb,
    year_start integer,
    weekly_off jsonb,
    holidays jsonb,
    work_start_time text,
    work_end_time text,
    late_grace_period integer,
    geo_fence_enabled boolean DEFAULT false,
    geo_fence_radius integer,
    geo_fence_location jsonb,
    overtime_enabled boolean DEFAULT false,
    overtime_after_hours integer,
    auto_clock_out_enabled boolean DEFAULT false,
    auto_clock_out_time text,
    tracking_config jsonb,
    extra_data jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by text
);


--
-- Name: leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_requests (
    id text NOT NULL,
    staff_id text NOT NULL,
    staff_name text,
    restaurant_id text NOT NULL,
    leave_type text,
    start_date text,
    end_date text,
    is_half_day boolean DEFAULT false,
    half_day_type text,
    reason text,
    total_days numeric,
    status text DEFAULT 'pending'::text,
    approved_by text,
    approved_at text,
    rejected_reason text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: legacy_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_bookings (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    booking_number text,
    type text,
    customer jsonb,
    event_name text,
    event_date text,
    event_end_date text,
    event_time text,
    event_end_time text,
    guest_count integer DEFAULT 0,
    special_instructions text,
    venue jsonb,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    discount jsonb,
    tax_amount numeric DEFAULT 0,
    service_charge numeric DEFAULT 0,
    total_amount numeric DEFAULT 0,
    payments jsonb DEFAULT '[]'::jsonb,
    paid_amount numeric DEFAULT 0,
    balance_amount numeric DEFAULT 0,
    payment_status text DEFAULT 'unpaid'::text,
    status text DEFAULT 'confirmed'::text,
    track_expense boolean DEFAULT false,
    expense_created boolean DEFAULT false,
    created_by jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason text
);


--
-- Name: legacy_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_staff (
    id text NOT NULL,
    name text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    email text DEFAULT ''::text,
    role text DEFAULT ''::text,
    address text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_bulk_delete_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_bulk_delete_logs (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    restaurant_name text DEFAULT ''::text,
    deleted_by text DEFAULT ''::text,
    deleted_by_name text DEFAULT ''::text,
    deleted_by_email text DEFAULT ''::text,
    deleted_by_phone text DEFAULT ''::text,
    reason text DEFAULT ''::text,
    deleted_count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    deleted_at timestamp with time zone DEFAULT now()
);


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    name_ar text DEFAULT ''::text,
    description text DEFAULT ''::text,
    price numeric DEFAULT 0,
    category text DEFAULT ''::text,
    category_id text DEFAULT ''::text,
    food_type text DEFAULT ''::text,
    spice_level text DEFAULT ''::text,
    is_veg boolean DEFAULT false,
    is_available boolean DEFAULT true,
    available boolean DEFAULT true,
    short_code text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    "order" integer DEFAULT 0,
    image text DEFAULT ''::text,
    image_keyword text DEFAULT ''::text,
    stock_quantity numeric,
    low_stock_threshold numeric DEFAULT 5,
    is_stock_managed boolean DEFAULT false,
    deduction_quantity numeric DEFAULT 1,
    available_from text DEFAULT ''::text,
    available_until text DEFAULT ''::text,
    sold_by_weight boolean DEFAULT false,
    price_unit text DEFAULT ''::text,
    plu_code text DEFAULT ''::text,
    source text DEFAULT ''::text,
    unit text DEFAULT ''::text,
    weight text DEFAULT ''::text,
    shelf_life integer,
    serving_size text DEFAULT ''::text,
    tax_group_id text DEFAULT ''::text,
    tax_inclusive boolean,
    discount_applicable boolean DEFAULT true,
    is_favorite boolean DEFAULT false,
    hide_image boolean DEFAULT false,
    is_out_of_stock boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    org_menu_item_id text DEFAULT ''::text,
    template_id text DEFAULT ''::text,
    variants jsonb DEFAULT '[]'::jsonb,
    customizations jsonb DEFAULT '[]'::jsonb,
    images jsonb DEFAULT '[]'::jsonb,
    allergens jsonb DEFAULT '[]'::jsonb,
    tags jsonb DEFAULT '[]'::jsonb,
    pricing_rules jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    synced_at timestamp with time zone,
    barcode text DEFAULT ''::text,
    barcode_format text DEFAULT ''::text,
    sub_category text DEFAULT ''::text,
    modifier_groups jsonb DEFAULT '[]'::jsonb
);


--
-- Name: menus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menus (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    description text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offers (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    discount_type text DEFAULT 'percentage'::text,
    discount_value numeric DEFAULT 0,
    min_order_value numeric DEFAULT 0,
    max_discount numeric,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    is_active boolean DEFAULT true,
    usage_limit integer,
    usage_count integer DEFAULT 0,
    is_first_order_only boolean DEFAULT false,
    auto_apply boolean DEFAULT false,
    scope text DEFAULT 'order'::text,
    target_categories jsonb DEFAULT '[]'::jsonb,
    target_items jsonb DEFAULT '[]'::jsonb,
    target_restaurants jsonb DEFAULT '"all"'::jsonb,
    schedule jsonb,
    promotion_type text DEFAULT 'discount'::text,
    bogo_config jsonb,
    event_label text,
    audience jsonb,
    tiers jsonb,
    cross_item_bogo jsonb,
    usage_limit_per_customer integer,
    priority integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: order_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_counters (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    counter_type text NOT NULL,
    date text,
    last_value integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    order_number text,
    daily_order_id integer,
    tab_number integer,
    idempotency_key text,
    sync_source text,
    order_type text DEFAULT 'dine-in'::text,
    status text DEFAULT 'pending'::text NOT NULL,
    last_status text,
    table_number text,
    table_id text,
    floor_id text,
    floor_name text,
    table_section text,
    room_number text,
    customer_id text,
    customer_name text,
    customer_phone text,
    customer_info jsonb,
    staff_info jsonb,
    assigned_staff jsonb,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric DEFAULT 0,
    total_amount numeric DEFAULT 0,
    final_amount numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    offer_discount numeric DEFAULT 0,
    manual_discount numeric DEFAULT 0,
    manual_discount_type text,
    manual_discount_value numeric DEFAULT 0,
    loyalty_discount numeric DEFAULT 0,
    total_discount_amount numeric DEFAULT 0,
    coupon_code text,
    coupon_id text,
    coupon_discount numeric DEFAULT 0,
    wallet_redeem_amount numeric DEFAULT 0,
    applied_offer jsonb,
    applied_offers jsonb DEFAULT '[]'::jsonb,
    selected_offer_name text,
    pricing_rule_id text,
    pricing_rule_name text,
    applied_pricing_rules jsonb DEFAULT '[]'::jsonb,
    zone_surcharge numeric DEFAULT 0,
    tax_amount numeric DEFAULT 0,
    tax_breakdown jsonb DEFAULT '[]'::jsonb,
    tax_inclusive_mode text,
    service_charge_rate numeric DEFAULT 0,
    service_charge_amount numeric DEFAULT 0,
    service_charge_enabled boolean DEFAULT false,
    tip_amount numeric DEFAULT 0,
    tip_percentage numeric DEFAULT 0,
    round_off_amount numeric DEFAULT 0,
    delivery_charge numeric DEFAULT 0,
    packing_charge numeric DEFAULT 0,
    payment_method text DEFAULT 'cash'::text,
    payment_status text DEFAULT 'unpaid'::text,
    paid_amount numeric DEFAULT 0,
    outstanding_amount numeric DEFAULT 0,
    cash_received numeric DEFAULT 0,
    change_returned numeric DEFAULT 0,
    split_payments jsonb,
    split_bill jsonb,
    loyalty_points_earned integer DEFAULT 0,
    loyalty_points_redeemed integer DEFAULT 0,
    redeem_loyalty_points integer DEFAULT 0,
    notes text,
    special_instructions text,
    kot_sent boolean DEFAULT false,
    kot_printed boolean DEFAULT false,
    kot_printed_at timestamp with time zone,
    kot_printed_stations jsonb,
    kot_number integer,
    kot_time timestamp with time zone,
    cooking_start_time timestamp with time zone,
    cooking_end_time timestamp with time zone,
    is_scheduled boolean DEFAULT false,
    scheduled_for timestamp with time zone,
    source text,
    aggregator_order_id text,
    aggregator_platform text,
    delivery_info jsonb,
    delivery_address jsonb,
    delivery_partner_id text,
    sub_restaurant_id text,
    sub_restaurant_name text,
    linked_to_hotel boolean DEFAULT false,
    hotel_check_in_id text,
    hotel_billed_and_checked_out boolean DEFAULT false,
    edit_count integer DEFAULT 0,
    edit_reason text,
    pre_edit_snapshot jsonb,
    cancelled_at timestamp with time zone,
    cancelled_by text,
    cancellation_reason text,
    refunded_at timestamp with time zone,
    refunded_by text,
    refund_amount numeric DEFAULT 0,
    refund_reason text,
    refund_type text,
    comp_amount numeric DEFAULT 0,
    void_items jsonb,
    removed_items jsonb DEFAULT '[]'::jsonb,
    share_token text,
    bill_printed boolean DEFAULT false,
    price_discrepancies jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    expired_at timestamp with time zone,
    item_count integer DEFAULT 0,
    covers integer DEFAULT 1,
    restored_at timestamp with time zone,
    restored_by text,
    restored_by_name text,
    restore_reason text,
    restoration_history jsonb DEFAULT '[]'::jsonb,
    bill_reprint_count integer DEFAULT 0,
    bill_reprint_history jsonb DEFAULT '[]'::jsonb,
    delivery_status text,
    delivery_assigned_at timestamp with time zone,
    edit_history jsonb DEFAULT '[]'::jsonb,
    auto_refund_amount numeric DEFAULT 0,
    auto_refund_reason text,
    auto_refund_at timestamp with time zone,
    auto_refund_by text,
    cashback_earned numeric,
    cashback_offer_id text,
    cashback_offer_name text,
    wallet_customer_id text,
    billing_clamped boolean,
    update_history jsonb DEFAULT '[]'::jsonb,
    update_count integer DEFAULT 0,
    offer_ids jsonb,
    last_updated_by text,
    billing_audit jsonb,
    discount_reason text,
    manager_pin text,
    split_payments_stale boolean,
    void_amount numeric,
    adjusted_final_amount numeric,
    comp_items jsonb,
    deleted_at timestamp with time zone,
    deleted_by text
);


--
-- Name: org_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_audit_log (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    action text DEFAULT ''::text,
    performed_by text DEFAULT ''::text,
    entity_type text,
    entity_id text,
    details jsonb DEFAULT '{}'::jsonb,
    performed_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: org_menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_menu_items (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    template_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    description text DEFAULT ''::text,
    category text DEFAULT ''::text,
    base_price numeric DEFAULT 0,
    variants jsonb DEFAULT '[]'::jsonb,
    image text DEFAULT ''::text,
    images jsonb DEFAULT '[]'::jsonb,
    is_veg boolean DEFAULT false,
    tags jsonb DEFAULT '[]'::jsonb,
    is_locked boolean DEFAULT false,
    lock_fields jsonb DEFAULT '[]'::jsonb,
    sort_order integer DEFAULT 0,
    short_code text DEFAULT ''::text,
    customizations jsonb DEFAULT '[]'::jsonb,
    dine_in_price numeric,
    takeaway_price numeric,
    delivery_price numeric,
    allergens jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    outlet_prices jsonb DEFAULT '{}'::jsonb,
    barcode text DEFAULT ''::text,
    barcode_format text DEFAULT ''::text,
    sub_category text DEFAULT ''::text,
    modifier_groups jsonb DEFAULT '[]'::jsonb
);


--
-- Name: org_menu_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_menu_templates (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    description text DEFAULT ''::text,
    categories jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'active'::text,
    assigned_outlets jsonb DEFAULT '[]'::jsonb,
    last_pushed_at text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: org_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_settings (
    id text NOT NULL,
    count integer,
    current integer,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: otp_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_verification (
    id text NOT NULL,
    phone text DEFAULT ''::text,
    otp text DEFAULT ''::text,
    otp_expiry timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: owner_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owner_preferences (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    insight_categories jsonb DEFAULT '[]'::jsonb,
    preferred_metrics jsonb DEFAULT '[]'::jsonb,
    dashboard_layout jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    email_enabled boolean,
    active_report_hours_utc jsonb,
    report_time_utc integer
);


--
-- Name: parking_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_configs (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    total_capacity integer DEFAULT 0,
    operating_hours jsonb DEFAULT '{}'::jsonb,
    currency text DEFAULT ''::text,
    enable_prepaid boolean DEFAULT false,
    vat_percentage numeric DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: parking_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_rates (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    vehicle_type text DEFAULT ''::text,
    rate_type text DEFAULT ''::text,
    amount numeric DEFAULT 0,
    free_minutes integer DEFAULT 0,
    max_daily numeric DEFAULT 0,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: parking_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_slots (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    zone_id text DEFAULT ''::text,
    slot_number text DEFAULT ''::text,
    type text DEFAULT ''::text,
    status text DEFAULT 'available'::text,
    vehicle_type text DEFAULT ''::text,
    current_ticket_id text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: parking_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_tickets (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    zone_id text DEFAULT ''::text,
    slot_id text DEFAULT ''::text,
    rate_id text DEFAULT ''::text,
    vehicle_number text DEFAULT ''::text,
    vehicle_type text DEFAULT ''::text,
    entry_time timestamp with time zone,
    exit_time timestamp with time zone,
    duration numeric DEFAULT 0,
    amount numeric DEFAULT 0,
    payment_status text DEFAULT 'pending'::text,
    payment_method text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: parking_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_zones (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    type text DEFAULT ''::text,
    total_slots integer DEFAULT 0,
    occupied_slots integer DEFAULT 0,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pay_slips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pay_slips (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    run_id text NOT NULL,
    staff_id text NOT NULL,
    staff_name text,
    role text,
    month text,
    base_salary numeric,
    allowances jsonb,
    deductions jsonb,
    gross_pay numeric,
    net_pay numeric,
    attendance_summary jsonb,
    lop_deduction numeric,
    overtime_pay numeric,
    status text DEFAULT 'generated'::text,
    paid_date timestamp with time zone,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_config (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    staff_id text NOT NULL,
    staff_name text,
    role text,
    base_salary numeric,
    allowances jsonb,
    deductions jsonb,
    gross_pay numeric,
    total_deductions numeric,
    net_pay numeric,
    pay_frequency text DEFAULT 'monthly'::text,
    bank_account text,
    created_by text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    month text,
    total_gross numeric,
    total_deductions numeric,
    total_net numeric,
    staff_count integer,
    working_days integer,
    has_attendance_data boolean DEFAULT false,
    status text DEFAULT 'draft'::text,
    paid_date timestamp with time zone,
    paid_by text,
    created_by text,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: phone_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_calls (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    bolna_execution_id text DEFAULT ''::text,
    status text DEFAULT ''::text,
    caller_number text DEFAULT ''::text,
    duration numeric,
    transcript text DEFAULT ''::text,
    summary text DEFAULT ''::text,
    recording_url text DEFAULT ''::text,
    metadata jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pms_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pms_bookings (
    id text NOT NULL,
    hotel_id text,
    room_id text,
    room_number text,
    guest_id text,
    guest_name text,
    status text DEFAULT 'confirmed'::text,
    check_in_date text,
    check_out_date text,
    checked_in_at timestamp with time zone,
    checked_out_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pms_guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pms_guests (
    id text NOT NULL,
    hotel_id text,
    name text,
    phone text,
    email text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pms_housekeeping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pms_housekeeping (
    id text NOT NULL,
    hotel_id text,
    room_id text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pms_maintenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pms_maintenance (
    id text NOT NULL,
    hotel_id text,
    room_id text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pms_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pms_rooms (
    id text NOT NULL,
    hotel_id text,
    room_number text,
    room_type text,
    floor text,
    status text DEFAULT 'available'::text,
    current_booking_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pos_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_invoices (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    invoice_number text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    subtotal numeric DEFAULT 0,
    tax numeric DEFAULT 0,
    total numeric DEFAULT 0,
    discount numeric DEFAULT 0,
    customer_name text DEFAULT ''::text,
    payment_method text DEFAULT ''::text,
    cash_received numeric DEFAULT 0,
    change_returned numeric DEFAULT 0,
    invoice_date timestamp with time zone,
    generated_by text DEFAULT ''::text,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: pos_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_payments (
    id text NOT NULL,
    amount numeric DEFAULT 0,
    method text DEFAULT ''::text,
    order_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: print_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.print_diagnostics (
    id text NOT NULL,
    restaurant_id text,
    terminal_id text,
    type text,
    method text,
    success boolean,
    device_name text,
    device_matched boolean,
    failure_reason text,
    hint text,
    os text,
    app_version text,
    electron_version text,
    event jsonb,
    created_at timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: production_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_entries (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: production_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.production_orders (
    id text NOT NULL,
    organization_id text DEFAULT ''::text,
    central_kitchen_id text DEFAULT ''::text,
    order_number text DEFAULT ''::text,
    recipe_id text DEFAULT ''::text,
    recipe_name text DEFAULT ''::text,
    target_quantity numeric DEFAULT 0,
    produced_quantity numeric,
    unit text DEFAULT ''::text,
    status text DEFAULT 'planned'::text,
    scheduled_date timestamp with time zone,
    completed_date timestamp with time zone,
    ingredients_consumed jsonb DEFAULT '[]'::jsonb,
    production_entry_id text,
    distribution_plan_id text,
    notes text DEFAULT ''::text,
    created_by text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: public_tool_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_tool_usage (
    id text NOT NULL,
    ip_address text DEFAULT ''::text,
    date text DEFAULT ''::text,
    call_count integer DEFAULT 0,
    last_call_at timestamp with time zone,
    last_tool text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    supplier_id text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    total_amount numeric DEFAULT 0,
    status text DEFAULT 'draft'::text,
    delivery_date timestamp with time zone,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    expected_delivery_date timestamp with time zone,
    received_at timestamp with time zone
);


--
-- Name: purchase_requisitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_requisitions (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    requested_by text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text,
    purchase_order_id text DEFAULT ''::text,
    priority text DEFAULT 'medium'::text,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: query_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_cache (
    id text NOT NULL,
    query text DEFAULT ''::text,
    response text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    model text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


--
-- Name: rag_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rag_knowledge (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    content text DEFAULT ''::text,
    type text DEFAULT ''::text,
    embedding jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    chunk_index integer DEFAULT 0,
    total_chunks integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    id text NOT NULL,
    client_id text DEFAULT ''::text,
    count integer DEFAULT 0,
    window_start timestamp with time zone,
    is_blocked boolean DEFAULT false,
    blocked_until timestamp with time zone,
    last_updated timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: razorpay_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.razorpay_tokens (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    access_token text DEFAULT ''::text,
    refresh_token text DEFAULT ''::text,
    account_id text DEFAULT ''::text,
    public_token text DEFAULT ''::text,
    token_type text DEFAULT ''::text,
    expires_at timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipes (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    menu_item_id text,
    menu_item_name text,
    name text,
    description text,
    category text,
    servings integer,
    prep_time integer,
    cook_time integer,
    ingredients jsonb DEFAULT '[]'::jsonb,
    instructions jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    is_auto_generated boolean DEFAULT false,
    created_by text,
    updated_by text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: rest_booking_venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rest_booking_venues (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    capacity integer DEFAULT 0,
    price_per_hour numeric DEFAULT 0,
    amenities jsonb DEFAULT '[]'::jsonb,
    images jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'active'::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: rest_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rest_bookings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    customer_phone text DEFAULT ''::text,
    date text DEFAULT ''::text,
    "time" text DEFAULT ''::text,
    party_size integer DEFAULT 0,
    duration text DEFAULT ''::text,
    table_id text DEFAULT ''::text,
    venue_id text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    notes text DEFAULT ''::text,
    total_amount numeric DEFAULT 0,
    advance_amount numeric DEFAULT 0,
    payments jsonb DEFAULT '[]'::jsonb,
    items jsonb DEFAULT '[]'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    venue jsonb
);


--
-- Name: restaurant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_settings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    type text DEFAULT ''::text,
    settings jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: restaurant_shift_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_shift_settings (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    shift_types jsonb,
    operating_hours jsonb,
    peak_hours jsonb,
    min_rest_hours numeric DEFAULT 8,
    max_hours_per_week numeric DEFAULT 40,
    max_hours_per_day numeric DEFAULT 8,
    time_off jsonb,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurants (
    id text NOT NULL,
    owner_id text,
    name text NOT NULL,
    address text DEFAULT ''::text,
    city text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    email text DEFAULT ''::text,
    cuisine jsonb DEFAULT '[]'::jsonb,
    description text DEFAULT ''::text,
    logo text DEFAULT ''::text,
    cover_image text DEFAULT ''::text,
    business_type text DEFAULT 'restaurant'::text,
    status text DEFAULT 'active'::text,
    is_active boolean DEFAULT true,
    country_code text DEFAULT 'IN'::text,
    currency_symbol text DEFAULT '₹'::text,
    subdomain text,
    subdomain_enabled boolean DEFAULT false,
    url_slug text,
    restaurant_code text,
    qr_data text,
    legal_business_name text,
    gstin text,
    fssai text,
    pan_number text,
    business_registration_number text,
    show_gst_on_invoice boolean DEFAULT false,
    staff_count integer DEFAULT 0,
    seating_capacity integer DEFAULT 0,
    onboarding_step integer DEFAULT 0,
    parent_restaurant_id text,
    has_default_menu boolean DEFAULT false,
    operating_hours jsonb DEFAULT '{}'::jsonb,
    features jsonb DEFAULT '[]'::jsonb,
    pos_settings jsonb DEFAULT '{}'::jsonb,
    order_settings jsonb DEFAULT '{}'::jsonb,
    print_settings jsonb DEFAULT '{}'::jsonb,
    ecr_settings jsonb DEFAULT '{}'::jsonb,
    pricing_settings jsonb DEFAULT '{}'::jsonb,
    tax_settings jsonb DEFAULT '{}'::jsonb,
    currency_settings jsonb DEFAULT '{}'::jsonb,
    customer_app_settings jsonb DEFAULT '{}'::jsonb,
    billing_settings jsonb DEFAULT '{}'::jsonb,
    billing_audit jsonb DEFAULT '{}'::jsonb,
    booking_settings jsonb DEFAULT '{}'::jsonb,
    feedback_settings jsonb DEFAULT '{}'::jsonb,
    bar_inventory_settings jsonb DEFAULT '{}'::jsonb,
    discount_approval_settings jsonb DEFAULT '{}'::jsonb,
    kot_settings jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    menu jsonb,
    organization_id text DEFAULT ''::text,
    aggregator_config jsonb
);


--
-- Name: room_maintenance_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_maintenance_schedules (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    room_id text,
    room_number text,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    reason text,
    status text DEFAULT 'active'::text,
    created_by text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sadad_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sadad_transactions (
    id text NOT NULL,
    restaurant_id text,
    merchant_order_no text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: saved_carts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_carts (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    user_id text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    table_id text DEFAULT ''::text,
    customer_name text DEFAULT ''::text,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    name text DEFAULT ''::text,
    type text DEFAULT 'parked'::text,
    is_active boolean DEFAULT true,
    customer_info jsonb,
    order_type text DEFAULT 'dine-in'::text,
    table_number text,
    payment_method text DEFAULT 'cash'::text,
    created_by jsonb
);


--
-- Name: security_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_logs (
    id text NOT NULL,
    event text DEFAULT ''::text,
    client_ip text DEFAULT ''::text,
    user_agent text DEFAULT ''::text,
    url text DEFAULT ''::text,
    method text DEFAULT ''::text,
    details jsonb DEFAULT '{}'::jsonb,
    "timestamp" timestamp with time zone DEFAULT now(),
    request_id text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shifts (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    organization_id text,
    opening_cash numeric DEFAULT 0,
    opened_by jsonb,
    opened_at timestamp with time zone,
    status text DEFAULT 'open'::text,
    transactions jsonb DEFAULT '[]'::jsonb,
    cash_in numeric DEFAULT 0,
    cash_out numeric DEFAULT 0,
    cash_drops numeric DEFAULT 0,
    closing_cash numeric,
    closed_by text,
    closed_by_name text,
    closed_at timestamp with time zone,
    closing_notes text,
    denominations jsonb,
    total_sales numeric,
    cash_sales numeric,
    card_sales numeric,
    upi_sales numeric,
    aggregator_sales numeric,
    other_sales numeric,
    order_count integer,
    total_tips numeric,
    cash_tips numeric,
    card_tips numeric,
    service_charge_collected numeric,
    expected_cash numeric,
    cash_difference numeric,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: space_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.space_bookings (
    id text NOT NULL,
    owner_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    table_id text DEFAULT ''::text,
    date text DEFAULT ''::text,
    start_time text DEFAULT ''::text,
    end_time text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    guest_name text DEFAULT ''::text,
    guest_phone text DEFAULT ''::text,
    party_size integer DEFAULT 0,
    notes text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_availability (
    id text NOT NULL,
    staff_id text,
    availability jsonb,
    preferences jsonb,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_credentials (
    id text NOT NULL,
    staff_id text DEFAULT ''::text,
    login_id text DEFAULT ''::text,
    temporary_password text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone
);


--
-- Name: staff_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_locations (
    id text NOT NULL,
    staff_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    latitude numeric,
    longitude numeric,
    accuracy numeric,
    "timestamp" timestamp with time zone DEFAULT now(),
    type text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: staff_locations_latest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_locations_latest (
    id text NOT NULL,
    staff_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    latitude numeric,
    longitude numeric,
    accuracy numeric,
    last_updated timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT false,
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: staff_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_shifts (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    staff_id text,
    date text,
    start_time text,
    end_time text,
    role text,
    notes text,
    shift_name text,
    shift_id text,
    color text,
    required_employees integer,
    required_roles jsonb,
    is_understaffed boolean,
    has_conflicts boolean,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_users (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    name text,
    phone text,
    email text,
    password text,
    role text,
    status text DEFAULT 'active'::text,
    login_id text,
    username text,
    username_lower text,
    address text,
    aadhar text,
    salary numeric,
    start_date timestamp with time zone,
    phone_verified boolean DEFAULT false,
    email_verified boolean DEFAULT false,
    provider text,
    temporary_password boolean DEFAULT false,
    last_login timestamp with time zone,
    page_access jsonb,
    extra_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: stock_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_audits (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: stock_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_batches (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    inventory_item_id text NOT NULL,
    inventory_item_name text,
    quantity numeric DEFAULT 0,
    initial_qty numeric DEFAULT 0,
    remaining_qty numeric DEFAULT 0,
    unit text,
    mfg_date timestamp with time zone,
    expiry_date timestamp with time zone,
    expiry_days integer,
    cost_per_unit numeric DEFAULT 0,
    supplier text,
    source text,
    status text DEFAULT 'active'::text,
    batch_id text,
    added_by text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    batch_number text
);


--
-- Name: stock_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfers (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    from_location text DEFAULT ''::text,
    to_location text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text,
    transfer_date timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sub_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sub_admins (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sub_restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sub_restaurants (
    id text NOT NULL,
    restaurant_id text,
    status text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: supplier_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_invoices (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    supplier_id text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    purchase_order_id text,
    invoice_date timestamp with time zone
);


--
-- Name: supplier_performance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_performance (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    supplier_id text DEFAULT ''::text,
    metrics jsonb DEFAULT '{}'::jsonb,
    evaluation_date timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    overall_score numeric
);


--
-- Name: supplier_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_returns (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    supplier_id text DEFAULT ''::text,
    items jsonb DEFAULT '[]'::jsonb,
    reason text DEFAULT ''::text,
    status text DEFAULT 'pending'::text,
    return_date timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    name text DEFAULT ''::text,
    phone text DEFAULT ''::text,
    email text DEFAULT ''::text,
    address jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    status text DEFAULT 'active'::text,
    gst_number text DEFAULT ''::text,
    payment_terms text DEFAULT ''::text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    id text NOT NULL,
    free_limit integer DEFAULT 0,
    starter_limit integer DEFAULT 0,
    professional_limit integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tables (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    floor_id text NOT NULL,
    name text NOT NULL,
    floor_name text,
    capacity integer DEFAULT 4,
    section text DEFAULT 'Main'::text,
    status text DEFAULT 'available'::text,
    current_order_id text,
    last_order_time timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: tax_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_settings (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    tax_rate numeric DEFAULT 0,
    tax_name text DEFAULT ''::text,
    tax_type text DEFAULT ''::text,
    is_active boolean DEFAULT true,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: token_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_usage (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    date text DEFAULT ''::text,
    model text DEFAULT ''::text,
    total_tokens integer DEFAULT 0,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    cost numeric DEFAULT 0,
    request_count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: user_restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_restaurants (
    id text NOT NULL,
    user_id text DEFAULT ''::text,
    restaurant_id text DEFAULT ''::text,
    role text DEFAULT ''::text,
    page_access jsonb DEFAULT '{}'::jsonb,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waitlist (
    id text NOT NULL,
    restaurant_id text,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: waste_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waste_entries (
    id text NOT NULL,
    restaurant_id text NOT NULL,
    item_id text,
    item_name text,
    quantity numeric DEFAULT 0,
    unit text,
    reason text,
    source text,
    cost_per_unit numeric,
    waste_value numeric,
    total_cost numeric,
    batch_id text,
    notes text,
    recorded_by text,
    date timestamp with time zone,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_conversation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversation_logs (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    customer_phone text DEFAULT ''::text,
    contact_name text DEFAULT ''::text,
    incoming_type text DEFAULT ''::text,
    incoming_text text DEFAULT ''::text,
    interactive_id text DEFAULT ''::text,
    response_count integer DEFAULT 0,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_order_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_order_logs (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    customer_phone text DEFAULT ''::text,
    message text DEFAULT ''::text,
    parsed_order jsonb DEFAULT '{}'::jsonb,
    "timestamp" timestamp with time zone DEFAULT now(),
    extra_data jsonb DEFAULT '{}'::jsonb
);


--
-- Name: whatsapp_ordering_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_ordering_config (
    id text NOT NULL,
    restaurant_id text DEFAULT ''::text,
    access_token text DEFAULT ''::text,
    phone_number_id text DEFAULT ''::text,
    business_account_id text DEFAULT ''::text,
    webhook_verify_token text DEFAULT ''::text,
    greeting text DEFAULT ''::text,
    menu_header text DEFAULT ''::text,
    payment_mode text DEFAULT ''::text,
    payment_link text DEFAULT ''::text,
    auto_accept_orders boolean DEFAULT false,
    enabled boolean DEFAULT false,
    extra_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: admin_tasks admin_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_tasks
    ADD CONSTRAINT admin_tasks_pkey PRIMARY KEY (id);


--
-- Name: aggregator_webhook_logs aggregator_webhook_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregator_webhook_logs
    ADD CONSTRAINT aggregator_webhook_logs_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_insights_usage ai_insights_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_insights_usage
    ADD CONSTRAINT ai_insights_usage_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: attendance attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance
    ADD CONSTRAINT attendance_pkey PRIMARY KEY (id);


--
-- Name: automation_logs automation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_logs
    ADD CONSTRAINT automation_logs_pkey PRIMARY KEY (id);


--
-- Name: automation_settings automation_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_settings
    ADD CONSTRAINT automation_settings_pkey PRIMARY KEY (id);


--
-- Name: automation_templates automation_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_templates
    ADD CONSTRAINT automation_templates_pkey PRIMARY KEY (id);


--
-- Name: automations automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);


--
-- Name: bar_bottles bar_bottles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bar_bottles
    ADD CONSTRAINT bar_bottles_pkey PRIMARY KEY (id);


--
-- Name: bar_reconciliation bar_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bar_reconciliation
    ADD CONSTRAINT bar_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: blocked_ips blocked_ips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_ips
    ADD CONSTRAINT blocked_ips_pkey PRIMARY KEY (id);


--
-- Name: bolna_agents bolna_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bolna_agents
    ADD CONSTRAINT bolna_agents_pkey PRIMARY KEY (id);


--
-- Name: booking_venues booking_venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_venues
    ADD CONSTRAINT booking_venues_pkey PRIMARY KEY (id);


--
-- Name: bookings_v2 bookings_v2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings_v2
    ADD CONSTRAINT bookings_v2_pkey PRIMARY KEY (id);


--
-- Name: cash_registers cash_registers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_pkey PRIMARY KEY (id);


--
-- Name: chart_of_accounts chart_of_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_pkey PRIMARY KEY (id);


--
-- Name: chatbot_conversations chatbot_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chatbot_conversations
    ADD CONSTRAINT chatbot_conversations_pkey PRIMARY KEY (id);


--
-- Name: chatgpt_usage chatgpt_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chatgpt_usage
    ADD CONSTRAINT chatgpt_usage_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: customer_groups customer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_groups
    ADD CONSTRAINT customer_groups_pkey PRIMARY KEY (id);


--
-- Name: customer_offer_usage customer_offer_usage_offer_id_customer_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_offer_usage
    ADD CONSTRAINT customer_offer_usage_offer_id_customer_key_key UNIQUE (offer_id, customer_key);


--
-- Name: customer_offer_usage customer_offer_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_offer_usage
    ADD CONSTRAINT customer_offer_usage_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: d365_sync_log d365_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.d365_sync_log
    ADD CONSTRAINT d365_sync_log_pkey PRIMARY KEY (id);


--
-- Name: daily_stats daily_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_stats
    ADD CONSTRAINT daily_stats_pkey PRIMARY KEY (id);


--
-- Name: demo_requests demo_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_requests
    ADD CONSTRAINT demo_requests_pkey PRIMARY KEY (id);


--
-- Name: desktop_auth_sessions desktop_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desktop_auth_sessions
    ADD CONSTRAINT desktop_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: dine_dodo_billing dine_dodo_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_dodo_billing
    ADD CONSTRAINT dine_dodo_billing_pkey PRIMARY KEY (id);


--
-- Name: dine_dodo_disputes dine_dodo_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_dodo_disputes
    ADD CONSTRAINT dine_dodo_disputes_pkey PRIMARY KEY (id);


--
-- Name: dine_dodo_orders dine_dodo_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_dodo_orders
    ADD CONSTRAINT dine_dodo_orders_pkey PRIMARY KEY (id);


--
-- Name: dine_dodo_refunds dine_dodo_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_dodo_refunds
    ADD CONSTRAINT dine_dodo_refunds_pkey PRIMARY KEY (id);


--
-- Name: dine_dodo_webhook_events dine_dodo_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_dodo_webhook_events
    ADD CONSTRAINT dine_dodo_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: dine_orders dine_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_orders
    ADD CONSTRAINT dine_orders_pkey PRIMARY KEY (id);


--
-- Name: dine_payments dine_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_payments
    ADD CONSTRAINT dine_payments_pkey PRIMARY KEY (id);


--
-- Name: dine_razorpay_orders dine_razorpay_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_razorpay_orders
    ADD CONSTRAINT dine_razorpay_orders_pkey PRIMARY KEY (id);


--
-- Name: dine_subscriptions dine_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_subscriptions
    ADD CONSTRAINT dine_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: dine_user_data dine_user_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_user_data
    ADD CONSTRAINT dine_user_data_pkey PRIMARY KEY (id);


--
-- Name: dine_webhook_events dine_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dine_webhook_events
    ADD CONSTRAINT dine_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: dineai_cheap_sessions dineai_cheap_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_cheap_sessions
    ADD CONSTRAINT dineai_cheap_sessions_pkey PRIMARY KEY (id);


--
-- Name: dineai_conversations dineai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_conversations
    ADD CONSTRAINT dineai_conversations_pkey PRIMARY KEY (id);


--
-- Name: dineai_knowledge dineai_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_knowledge
    ADD CONSTRAINT dineai_knowledge_pkey PRIMARY KEY (id);


--
-- Name: dineai_realtime_function_calls dineai_realtime_function_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_realtime_function_calls
    ADD CONSTRAINT dineai_realtime_function_calls_pkey PRIMARY KEY (id);


--
-- Name: dineai_realtime_sessions dineai_realtime_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_realtime_sessions
    ADD CONSTRAINT dineai_realtime_sessions_pkey PRIMARY KEY (id);


--
-- Name: dineai_settings dineai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_settings
    ADD CONSTRAINT dineai_settings_pkey PRIMARY KEY (id);


--
-- Name: dineai_usage dineai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dineai_usage
    ADD CONSTRAINT dineai_usage_pkey PRIMARY KEY (id);


--
-- Name: discount_approvals discount_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_approvals
    ADD CONSTRAINT discount_approvals_pkey PRIMARY KEY (id);


--
-- Name: discount_settings discount_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_settings
    ADD CONSTRAINT discount_settings_pkey PRIMARY KEY (id);


--
-- Name: distribution_plans distribution_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distribution_plans
    ADD CONSTRAINT distribution_plans_pkey PRIMARY KEY (id);


--
-- Name: email_otp_temp email_otp_temp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_otp_temp
    ADD CONSTRAINT email_otp_temp_pkey PRIMARY KEY (id);


--
-- Name: ent_organizations ent_organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ent_organizations
    ADD CONSTRAINT ent_organizations_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: feedback_forms feedback_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_forms
    ADD CONSTRAINT feedback_forms_pkey PRIMARY KEY (id);


--
-- Name: feedback_responses feedback_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_responses
    ADD CONSTRAINT feedback_responses_pkey PRIMARY KEY (id);


--
-- Name: floors floors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floors
    ADD CONSTRAINT floors_pkey PRIMARY KEY (id, restaurant_id);


--
-- Name: goods_receipt_notes goods_receipt_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_receipt_notes
    ADD CONSTRAINT goods_receipt_notes_pkey PRIMARY KEY (id);


--
-- Name: google_business_tokens google_business_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_business_tokens
    ADD CONSTRAINT google_business_tokens_pkey PRIMARY KEY (id);


--
-- Name: google_review_settings google_review_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_review_settings
    ADD CONSTRAINT google_review_settings_pkey PRIMARY KEY (id);


--
-- Name: google_reviews_cache google_reviews_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_reviews_cache
    ADD CONSTRAINT google_reviews_cache_pkey PRIMARY KEY (id);


--
-- Name: hotel_bookings hotel_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hotel_bookings
    ADD CONSTRAINT hotel_bookings_pkey PRIMARY KEY (id);


--
-- Name: hotel_checkins hotel_checkins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hotel_checkins
    ADD CONSTRAINT hotel_checkins_pkey PRIMARY KEY (id);


--
-- Name: hotel_guests hotel_guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hotel_guests
    ADD CONSTRAINT hotel_guests_pkey PRIMARY KEY (id);


--
-- Name: hotel_rooms hotel_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hotel_rooms
    ADD CONSTRAINT hotel_rooms_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: indent_requests indent_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indent_requests
    ADD CONSTRAINT indent_requests_pkey PRIMARY KEY (id);


--
-- Name: inv_challans inv_challans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_challans
    ADD CONSTRAINT inv_challans_pkey PRIMARY KEY (id);


--
-- Name: inv_customers inv_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_customers
    ADD CONSTRAINT inv_customers_pkey PRIMARY KEY (id);


--
-- Name: inv_expenses inv_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_expenses
    ADD CONSTRAINT inv_expenses_pkey PRIMARY KEY (id);


--
-- Name: inv_invoices inv_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_invoices
    ADD CONSTRAINT inv_invoices_pkey PRIMARY KEY (id);


--
-- Name: inv_items inv_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_items
    ADD CONSTRAINT inv_items_pkey PRIMARY KEY (id);


--
-- Name: inv_number_sequences inv_number_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_number_sequences
    ADD CONSTRAINT inv_number_sequences_pkey PRIMARY KEY (id);


--
-- Name: inv_organizations inv_organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_organizations
    ADD CONSTRAINT inv_organizations_pkey PRIMARY KEY (id);


--
-- Name: inv_payments inv_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_payments
    ADD CONSTRAINT inv_payments_pkey PRIMARY KEY (id);


--
-- Name: inv_quotes inv_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_quotes
    ADD CONSTRAINT inv_quotes_pkey PRIMARY KEY (id);


--
-- Name: inv_settings inv_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_settings
    ADD CONSTRAINT inv_settings_pkey PRIMARY KEY (id);


--
-- Name: inventory_categories inventory_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_categories
    ADD CONSTRAINT inventory_categories_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: inventory_transactions inventory_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: leave_balances leave_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balances
    ADD CONSTRAINT leave_balances_pkey PRIMARY KEY (id);


--
-- Name: leave_config leave_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_config
    ADD CONSTRAINT leave_config_pkey PRIMARY KEY (id);


--
-- Name: leave_requests leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);


--
-- Name: legacy_bookings legacy_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_bookings
    ADD CONSTRAINT legacy_bookings_pkey PRIMARY KEY (id);


--
-- Name: legacy_staff legacy_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_staff
    ADD CONSTRAINT legacy_staff_pkey PRIMARY KEY (id);


--
-- Name: menu_bulk_delete_logs menu_bulk_delete_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_bulk_delete_logs
    ADD CONSTRAINT menu_bulk_delete_logs_pkey PRIMARY KEY (id);


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);


--
-- Name: menus menus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menus
    ADD CONSTRAINT menus_pkey PRIMARY KEY (id);


--
-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);


--
-- Name: order_counters order_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_counters
    ADD CONSTRAINT order_counters_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: org_audit_log org_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_audit_log
    ADD CONSTRAINT org_audit_log_pkey PRIMARY KEY (id);


--
-- Name: org_menu_items org_menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_menu_items
    ADD CONSTRAINT org_menu_items_pkey PRIMARY KEY (id);


--
-- Name: org_menu_templates org_menu_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_menu_templates
    ADD CONSTRAINT org_menu_templates_pkey PRIMARY KEY (id);


--
-- Name: org_settings org_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_settings
    ADD CONSTRAINT org_settings_pkey PRIMARY KEY (id);


--
-- Name: otp_verification otp_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_verification
    ADD CONSTRAINT otp_verification_pkey PRIMARY KEY (id);


--
-- Name: owner_preferences owner_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_preferences
    ADD CONSTRAINT owner_preferences_pkey PRIMARY KEY (id);


--
-- Name: parking_configs parking_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_configs
    ADD CONSTRAINT parking_configs_pkey PRIMARY KEY (id);


--
-- Name: parking_rates parking_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_rates
    ADD CONSTRAINT parking_rates_pkey PRIMARY KEY (id);


--
-- Name: parking_slots parking_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_slots
    ADD CONSTRAINT parking_slots_pkey PRIMARY KEY (id);


--
-- Name: parking_tickets parking_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_tickets
    ADD CONSTRAINT parking_tickets_pkey PRIMARY KEY (id);


--
-- Name: parking_zones parking_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_zones
    ADD CONSTRAINT parking_zones_pkey PRIMARY KEY (id);


--
-- Name: pay_slips pay_slips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pay_slips
    ADD CONSTRAINT pay_slips_pkey PRIMARY KEY (id);


--
-- Name: payroll_config payroll_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_config
    ADD CONSTRAINT payroll_config_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: phone_calls phone_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_calls
    ADD CONSTRAINT phone_calls_pkey PRIMARY KEY (id);


--
-- Name: pms_bookings pms_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pms_bookings
    ADD CONSTRAINT pms_bookings_pkey PRIMARY KEY (id);


--
-- Name: pms_guests pms_guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pms_guests
    ADD CONSTRAINT pms_guests_pkey PRIMARY KEY (id);


--
-- Name: pms_housekeeping pms_housekeeping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pms_housekeeping
    ADD CONSTRAINT pms_housekeeping_pkey PRIMARY KEY (id);


--
-- Name: pms_maintenance pms_maintenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pms_maintenance
    ADD CONSTRAINT pms_maintenance_pkey PRIMARY KEY (id);


--
-- Name: pms_rooms pms_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pms_rooms
    ADD CONSTRAINT pms_rooms_pkey PRIMARY KEY (id);


--
-- Name: pos_invoices pos_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_invoices
    ADD CONSTRAINT pos_invoices_pkey PRIMARY KEY (id);


--
-- Name: pos_payments pos_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_payments
    ADD CONSTRAINT pos_payments_pkey PRIMARY KEY (id);


--
-- Name: print_diagnostics print_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.print_diagnostics
    ADD CONSTRAINT print_diagnostics_pkey PRIMARY KEY (id);


--
-- Name: production_entries production_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_entries
    ADD CONSTRAINT production_entries_pkey PRIMARY KEY (id);


--
-- Name: production_orders production_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.production_orders
    ADD CONSTRAINT production_orders_pkey PRIMARY KEY (id);


--
-- Name: public_tool_usage public_tool_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_tool_usage
    ADD CONSTRAINT public_tool_usage_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: purchase_requisitions purchase_requisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_requisitions
    ADD CONSTRAINT purchase_requisitions_pkey PRIMARY KEY (id);


--
-- Name: query_cache query_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_cache
    ADD CONSTRAINT query_cache_pkey PRIMARY KEY (id);


--
-- Name: rag_knowledge rag_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_knowledge
    ADD CONSTRAINT rag_knowledge_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (id);


--
-- Name: razorpay_tokens razorpay_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.razorpay_tokens
    ADD CONSTRAINT razorpay_tokens_pkey PRIMARY KEY (id);


--
-- Name: recipes recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_pkey PRIMARY KEY (id);


--
-- Name: rest_booking_venues rest_booking_venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rest_booking_venues
    ADD CONSTRAINT rest_booking_venues_pkey PRIMARY KEY (id);


--
-- Name: rest_bookings rest_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rest_bookings
    ADD CONSTRAINT rest_bookings_pkey PRIMARY KEY (id);


--
-- Name: restaurant_settings restaurant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_settings
    ADD CONSTRAINT restaurant_settings_pkey PRIMARY KEY (id);


--
-- Name: restaurant_shift_settings restaurant_shift_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_shift_settings
    ADD CONSTRAINT restaurant_shift_settings_pkey PRIMARY KEY (id);


--
-- Name: restaurants restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_pkey PRIMARY KEY (id);


--
-- Name: room_maintenance_schedules room_maintenance_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_maintenance_schedules
    ADD CONSTRAINT room_maintenance_schedules_pkey PRIMARY KEY (id);


--
-- Name: sadad_transactions sadad_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sadad_transactions
    ADD CONSTRAINT sadad_transactions_pkey PRIMARY KEY (id);


--
-- Name: saved_carts saved_carts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_carts
    ADD CONSTRAINT saved_carts_pkey PRIMARY KEY (id);


--
-- Name: security_logs security_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_logs
    ADD CONSTRAINT security_logs_pkey PRIMARY KEY (id);


--
-- Name: shifts shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);


--
-- Name: space_bookings space_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.space_bookings
    ADD CONSTRAINT space_bookings_pkey PRIMARY KEY (id);


--
-- Name: staff_availability staff_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_availability
    ADD CONSTRAINT staff_availability_pkey PRIMARY KEY (id);


--
-- Name: staff_credentials staff_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_credentials
    ADD CONSTRAINT staff_credentials_pkey PRIMARY KEY (id);


--
-- Name: staff_locations_latest staff_locations_latest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_locations_latest
    ADD CONSTRAINT staff_locations_latest_pkey PRIMARY KEY (id);


--
-- Name: staff_locations staff_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_locations
    ADD CONSTRAINT staff_locations_pkey PRIMARY KEY (id);


--
-- Name: staff_shifts staff_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_pkey PRIMARY KEY (id);


--
-- Name: staff_users staff_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_users
    ADD CONSTRAINT staff_users_pkey PRIMARY KEY (id);


--
-- Name: stock_audits stock_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_audits
    ADD CONSTRAINT stock_audits_pkey PRIMARY KEY (id);


--
-- Name: stock_batches stock_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_batches
    ADD CONSTRAINT stock_batches_pkey PRIMARY KEY (id);


--
-- Name: stock_transfers stock_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_pkey PRIMARY KEY (id);


--
-- Name: sub_admins sub_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_admins
    ADD CONSTRAINT sub_admins_pkey PRIMARY KEY (id);


--
-- Name: sub_restaurants sub_restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sub_restaurants
    ADD CONSTRAINT sub_restaurants_pkey PRIMARY KEY (id);


--
-- Name: supplier_invoices supplier_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_invoices
    ADD CONSTRAINT supplier_invoices_pkey PRIMARY KEY (id);


--
-- Name: supplier_performance supplier_performance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_performance
    ADD CONSTRAINT supplier_performance_pkey PRIMARY KEY (id);


--
-- Name: supplier_returns supplier_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_returns
    ADD CONSTRAINT supplier_returns_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);


--
-- Name: tables tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_pkey PRIMARY KEY (id);


--
-- Name: tax_settings tax_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_settings
    ADD CONSTRAINT tax_settings_pkey PRIMARY KEY (id);


--
-- Name: token_usage token_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_usage
    ADD CONSTRAINT token_usage_pkey PRIMARY KEY (id);


--
-- Name: user_restaurants user_restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_restaurants
    ADD CONSTRAINT user_restaurants_pkey PRIMARY KEY (id);


--
-- Name: waitlist waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);


--
-- Name: waste_entries waste_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waste_entries
    ADD CONSTRAINT waste_entries_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_conversation_logs whatsapp_conversation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_logs
    ADD CONSTRAINT whatsapp_conversation_logs_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_order_logs whatsapp_order_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_order_logs
    ADD CONSTRAINT whatsapp_order_logs_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_ordering_config whatsapp_ordering_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_ordering_config
    ADD CONSTRAINT whatsapp_ordering_config_pkey PRIMARY KEY (id);


--
-- Name: idx_ai_conversations_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_conversations_restaurant ON public.ai_conversations USING btree (restaurant_id);


--
-- Name: idx_app_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_email ON public.app_users USING btree (email);


--
-- Name: idx_app_users_firebase_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_firebase_uid ON public.app_users USING btree (firebase_uid);


--
-- Name: idx_app_users_login_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_login_id ON public.app_users USING btree (login_id);


--
-- Name: idx_app_users_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_phone ON public.app_users USING btree (phone);


--
-- Name: idx_app_users_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_restaurant ON public.app_users USING btree (restaurant_id);


--
-- Name: idx_app_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_status ON public.app_users USING btree (status);


--
-- Name: idx_app_users_username_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_users_username_lower ON public.app_users USING btree (username_lower);


--
-- Name: idx_attendance_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_restaurant ON public.attendance USING btree (restaurant_id);


--
-- Name: idx_attendance_restaurant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_restaurant_date ON public.attendance USING btree (restaurant_id, date);


--
-- Name: idx_attendance_staff_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_staff_date ON public.attendance USING btree (staff_id, date);


--
-- Name: idx_automation_logs_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_logs_message_id ON public.automation_logs USING btree (message_id) WHERE ((message_id IS NOT NULL) AND (message_id <> ''::text));


--
-- Name: idx_automation_logs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_logs_restaurant ON public.automation_logs USING btree (restaurant_id);


--
-- Name: idx_automation_logs_restaurant_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_logs_restaurant_timestamp ON public.automation_logs USING btree (restaurant_id, "timestamp" DESC);


--
-- Name: idx_automation_logs_restaurant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_logs_restaurant_type ON public.automation_logs USING btree (restaurant_id, type);


--
-- Name: idx_automation_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_settings_restaurant ON public.automation_settings USING btree (restaurant_id);


--
-- Name: idx_automation_settings_restaurant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_settings_restaurant_type ON public.automation_settings USING btree (restaurant_id, type);


--
-- Name: idx_automation_templates_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_templates_restaurant ON public.automation_templates USING btree (restaurant_id);


--
-- Name: idx_automations_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automations_restaurant ON public.automations USING btree (restaurant_id);


--
-- Name: idx_bar_bottles_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bar_bottles_item ON public.bar_bottles USING btree (restaurant_id, inventory_item_id);


--
-- Name: idx_bar_bottles_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bar_bottles_restaurant ON public.bar_bottles USING btree (restaurant_id);


--
-- Name: idx_bar_bottles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bar_bottles_status ON public.bar_bottles USING btree (restaurant_id, status);


--
-- Name: idx_bar_recon_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bar_recon_date ON public.bar_reconciliation USING btree (restaurant_id, date DESC);


--
-- Name: idx_bar_recon_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bar_recon_restaurant ON public.bar_reconciliation USING btree (restaurant_id);


--
-- Name: idx_bolna_agents_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bolna_agents_restaurant ON public.bolna_agents USING btree (restaurant_id);


--
-- Name: idx_booking_venues_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_venues_restaurant ON public.booking_venues USING btree (restaurant_id);


--
-- Name: idx_bookings_v2_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_v2_event_date ON public.bookings_v2 USING btree (restaurant_id, event_date);


--
-- Name: idx_bookings_v2_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_v2_restaurant ON public.bookings_v2 USING btree (restaurant_id);


--
-- Name: idx_bookings_v2_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_v2_restaurant_status ON public.bookings_v2 USING btree (restaurant_id, status);


--
-- Name: idx_cash_registers_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_registers_restaurant ON public.cash_registers USING btree (restaurant_id);


--
-- Name: idx_cash_registers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_registers_status ON public.cash_registers USING btree (restaurant_id, status);


--
-- Name: idx_chatbot_conversations_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chatbot_conversations_restaurant ON public.chatbot_conversations USING btree (restaurant_id);


--
-- Name: idx_chatgpt_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chatgpt_usage_date ON public.chatgpt_usage USING btree (date);


--
-- Name: idx_chatgpt_usage_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chatgpt_usage_user ON public.chatgpt_usage USING btree (user_id);


--
-- Name: idx_coa_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coa_restaurant ON public.chart_of_accounts USING btree (restaurant_id);


--
-- Name: idx_coupons_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_restaurant ON public.coupons USING btree (restaurant_id);


--
-- Name: idx_customer_groups_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_groups_restaurant ON public.customer_groups USING btree (restaurant_id);


--
-- Name: idx_customer_offer_usage_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_offer_usage_customer ON public.customer_offer_usage USING btree (customer_key);


--
-- Name: idx_customer_offer_usage_offer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_offer_usage_offer ON public.customer_offer_usage USING btree (offer_id);


--
-- Name: idx_customers_firebase_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_firebase_uid ON public.customers USING btree (restaurant_id, firebase_uid);


--
-- Name: idx_customers_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_restaurant ON public.customers USING btree (restaurant_id);


--
-- Name: idx_customers_restaurant_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_restaurant_email ON public.customers USING btree (restaurant_id, email);


--
-- Name: idx_customers_restaurant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_restaurant_name ON public.customers USING btree (restaurant_id, name);


--
-- Name: idx_customers_restaurant_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_restaurant_phone ON public.customers USING btree (restaurant_id, phone);


--
-- Name: idx_customers_wallet_card_barcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_wallet_card_barcode ON public.customers USING btree (restaurant_id, wallet_card_barcode) WHERE (wallet_card_barcode IS NOT NULL);


--
-- Name: idx_customers_wallet_card_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_wallet_card_number ON public.customers USING btree (restaurant_id, wallet_card_number) WHERE (wallet_card_number IS NOT NULL);


--
-- Name: idx_d365_sync_log_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_d365_sync_log_restaurant ON public.d365_sync_log USING btree (restaurant_id);


--
-- Name: idx_d365_sync_log_restaurant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_d365_sync_log_restaurant_type ON public.d365_sync_log USING btree (restaurant_id, type);


--
-- Name: idx_d365_sync_log_synced_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_d365_sync_log_synced_at ON public.d365_sync_log USING btree (synced_at DESC);


--
-- Name: idx_daily_stats_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_stats_date ON public.daily_stats USING btree (date);


--
-- Name: idx_daily_stats_restaurant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_stats_restaurant_date ON public.daily_stats USING btree (restaurant_id, date DESC);


--
-- Name: idx_dine_dodo_billing_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_dodo_billing_user ON public.dine_dodo_billing USING btree (user_id);


--
-- Name: idx_dine_dodo_orders_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_dodo_orders_user ON public.dine_dodo_orders USING btree (user_id);


--
-- Name: idx_dine_payments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_payments_order ON public.dine_payments USING btree (order_id);


--
-- Name: idx_dine_payments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_payments_user ON public.dine_payments USING btree (user_id);


--
-- Name: idx_dine_razorpay_orders_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_razorpay_orders_user ON public.dine_razorpay_orders USING btree (user_id);


--
-- Name: idx_dine_subscriptions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_subscriptions_user ON public.dine_subscriptions USING btree (user_id);


--
-- Name: idx_dine_user_data_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dine_user_data_email ON public.dine_user_data USING btree (email);


--
-- Name: idx_dineai_cheap_sessions_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dineai_cheap_sessions_restaurant ON public.dineai_cheap_sessions USING btree (restaurant_id);


--
-- Name: idx_dineai_knowledge_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dineai_knowledge_restaurant ON public.dineai_knowledge USING btree (restaurant_id);


--
-- Name: idx_dineai_rt_func_calls_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dineai_rt_func_calls_session ON public.dineai_realtime_function_calls USING btree (session_id);


--
-- Name: idx_dineai_rt_sessions_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dineai_rt_sessions_restaurant ON public.dineai_realtime_sessions USING btree (restaurant_id);


--
-- Name: idx_dineai_usage_user_rest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dineai_usage_user_rest ON public.dineai_usage USING btree (user_id, restaurant_id);


--
-- Name: idx_discount_approvals_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_approvals_restaurant ON public.discount_approvals USING btree (restaurant_id);


--
-- Name: idx_discount_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_settings_restaurant ON public.discount_settings USING btree (restaurant_id);


--
-- Name: idx_distribution_plans_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distribution_plans_org ON public.distribution_plans USING btree (organization_id);


--
-- Name: idx_ent_organizations_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ent_organizations_owner ON public.ent_organizations USING btree (owner_id);


--
-- Name: idx_expenses_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date ON public.expenses USING btree (restaurant_id, date);


--
-- Name: idx_expenses_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_restaurant ON public.expenses USING btree (restaurant_id);


--
-- Name: idx_feedback_forms_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feedback_forms_restaurant ON public.feedback_forms USING btree (restaurant_id);


--
-- Name: idx_feedback_forms_short_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feedback_forms_short_code ON public.feedback_forms USING btree (((distribution ->> 'shortCode'::text))) WHERE (distribution IS NOT NULL);


--
-- Name: idx_feedback_responses_form; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feedback_responses_form ON public.feedback_responses USING btree (form_id);


--
-- Name: idx_feedback_responses_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feedback_responses_restaurant ON public.feedback_responses USING btree (restaurant_id);


--
-- Name: idx_floors_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_floors_restaurant ON public.floors USING btree (restaurant_id);


--
-- Name: idx_goods_receipt_notes_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_goods_receipt_notes_restaurant ON public.goods_receipt_notes USING btree (restaurant_id);


--
-- Name: idx_google_biz_tokens_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_biz_tokens_restaurant ON public.google_business_tokens USING btree (restaurant_id);


--
-- Name: idx_google_review_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_review_settings_restaurant ON public.google_review_settings USING btree (restaurant_id);


--
-- Name: idx_hotel_bookings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_bookings_restaurant ON public.hotel_bookings USING btree (restaurant_id);


--
-- Name: idx_hotel_bookings_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_bookings_restaurant_status ON public.hotel_bookings USING btree (restaurant_id, status);


--
-- Name: idx_hotel_bookings_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_bookings_room ON public.hotel_bookings USING btree (restaurant_id, room_number);


--
-- Name: idx_hotel_checkins_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_checkins_restaurant ON public.hotel_checkins USING btree (restaurant_id);


--
-- Name: idx_hotel_checkins_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_checkins_restaurant_status ON public.hotel_checkins USING btree (restaurant_id, status);


--
-- Name: idx_hotel_checkins_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_checkins_room ON public.hotel_checkins USING btree (restaurant_id, room_number);


--
-- Name: idx_hotel_guests_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_guests_phone ON public.hotel_guests USING btree (restaurant_id, phone);


--
-- Name: idx_hotel_guests_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_guests_restaurant ON public.hotel_guests USING btree (restaurant_id);


--
-- Name: idx_hotel_rooms_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_rooms_restaurant ON public.hotel_rooms USING btree (restaurant_id);


--
-- Name: idx_hotel_rooms_restaurant_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hotel_rooms_restaurant_number ON public.hotel_rooms USING btree (restaurant_id, room_number);


--
-- Name: idx_idempotency_keys_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_keys_restaurant ON public.idempotency_keys USING btree (restaurant_id);


--
-- Name: idx_indent_requests_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_indent_requests_org ON public.indent_requests USING btree (organization_id);


--
-- Name: idx_indent_requests_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_indent_requests_org_status ON public.indent_requests USING btree (organization_id, status);


--
-- Name: idx_inv_challans_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_challans_org_id ON public.inv_challans USING btree (org_id);


--
-- Name: idx_inv_customers_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_customers_org_id ON public.inv_customers USING btree (org_id);


--
-- Name: idx_inv_customers_org_mobile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_customers_org_mobile ON public.inv_customers USING btree (org_id, mobile);


--
-- Name: idx_inv_customers_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_customers_org_status ON public.inv_customers USING btree (org_id, status);


--
-- Name: idx_inv_expenses_org_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_expenses_org_category ON public.inv_expenses USING btree (org_id, category);


--
-- Name: idx_inv_expenses_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_expenses_org_id ON public.inv_expenses USING btree (org_id);


--
-- Name: idx_inv_invoices_org_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_invoices_org_customer ON public.inv_invoices USING btree (org_id, customer_id);


--
-- Name: idx_inv_invoices_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_invoices_org_id ON public.inv_invoices USING btree (org_id);


--
-- Name: idx_inv_invoices_org_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_invoices_org_source_ref ON public.inv_invoices USING btree (org_id, source_ref);


--
-- Name: idx_inv_invoices_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_invoices_org_status ON public.inv_invoices USING btree (org_id, status);


--
-- Name: idx_inv_items_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_org_id ON public.inv_items USING btree (org_id);


--
-- Name: idx_inv_items_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_org_status ON public.inv_items USING btree (org_id, status);


--
-- Name: idx_inv_number_sequences_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_number_sequences_org_id ON public.inv_number_sequences USING btree (org_id);


--
-- Name: idx_inv_organizations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_organizations_user_id ON public.inv_organizations USING btree (user_id);


--
-- Name: idx_inv_payments_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_payments_org_id ON public.inv_payments USING btree (org_id);


--
-- Name: idx_inv_payments_org_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_payments_org_invoice ON public.inv_payments USING btree (org_id, invoice_id);


--
-- Name: idx_inv_quotes_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_quotes_org_id ON public.inv_quotes USING btree (org_id);


--
-- Name: idx_inv_quotes_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_quotes_org_status ON public.inv_quotes USING btree (org_id, status);


--
-- Name: idx_inv_settings_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_settings_org_id ON public.inv_settings USING btree (org_id);


--
-- Name: idx_inv_tx_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_date ON public.inventory_transactions USING btree (restaurant_id, date DESC);


--
-- Name: idx_inv_tx_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_item ON public.inventory_transactions USING btree (restaurant_id, inventory_item_id);


--
-- Name: idx_inv_tx_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_order_id ON public.inventory_transactions USING btree (order_id);


--
-- Name: idx_inv_tx_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_reference ON public.inventory_transactions USING btree (reference_id);


--
-- Name: idx_inv_tx_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_restaurant ON public.inventory_transactions USING btree (restaurant_id);


--
-- Name: idx_inv_tx_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_tx_type ON public.inventory_transactions USING btree (restaurant_id, type);


--
-- Name: idx_inventory_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_restaurant ON public.inventory USING btree (restaurant_id);


--
-- Name: idx_inventory_restaurant_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_restaurant_category ON public.inventory USING btree (restaurant_id, category);


--
-- Name: idx_inventory_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_restaurant_status ON public.inventory USING btree (restaurant_id, status);


--
-- Name: idx_je_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_je_restaurant ON public.journal_entries USING btree (restaurant_id);


--
-- Name: idx_leave_balances_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_balances_restaurant ON public.leave_balances USING btree (restaurant_id);


--
-- Name: idx_leave_balances_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_balances_staff ON public.leave_balances USING btree (staff_id);


--
-- Name: idx_leave_config_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_config_restaurant ON public.leave_config USING btree (restaurant_id);


--
-- Name: idx_leave_requests_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_restaurant ON public.leave_requests USING btree (restaurant_id);


--
-- Name: idx_leave_requests_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_staff ON public.leave_requests USING btree (staff_id);


--
-- Name: idx_legacy_bookings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legacy_bookings_restaurant ON public.legacy_bookings USING btree (restaurant_id);


--
-- Name: idx_legacy_bookings_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legacy_bookings_restaurant_status ON public.legacy_bookings USING btree (restaurant_id, status);


--
-- Name: idx_legacy_staff_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legacy_staff_restaurant ON public.legacy_staff USING btree (restaurant_id);


--
-- Name: idx_menu_bulk_delete_logs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_bulk_delete_logs_restaurant ON public.menu_bulk_delete_logs USING btree (restaurant_id);


--
-- Name: idx_menu_items_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_restaurant ON public.menu_items USING btree (restaurant_id);


--
-- Name: idx_menu_items_restaurant_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_restaurant_category ON public.menu_items USING btree (restaurant_id, category);


--
-- Name: idx_menu_items_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_restaurant_status ON public.menu_items USING btree (restaurant_id, status);


--
-- Name: idx_menus_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menus_restaurant ON public.menus USING btree (restaurant_id);


--
-- Name: idx_offers_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offers_restaurant ON public.offers USING btree (restaurant_id);


--
-- Name: idx_offers_restaurant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offers_restaurant_active ON public.offers USING btree (restaurant_id, is_active);


--
-- Name: idx_order_counters_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_counters_restaurant ON public.order_counters USING btree (restaurant_id);


--
-- Name: idx_order_counters_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_counters_type_date ON public.order_counters USING btree (restaurant_id, counter_type, date);


--
-- Name: idx_orders_aggregator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_aggregator ON public.orders USING btree (aggregator_order_id) WHERE (aggregator_order_id IS NOT NULL);


--
-- Name: idx_orders_customer_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer_phone ON public.orders USING btree (restaurant_id, customer_phone) WHERE (customer_phone IS NOT NULL);


--
-- Name: idx_orders_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_orders_idempotency ON public.orders USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_orders_payment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_payment_status ON public.orders USING btree (restaurant_id, payment_status, created_at DESC);


--
-- Name: idx_orders_restaurant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_active ON public.orders USING btree (restaurant_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'preparing'::text, 'ready'::text]));


--
-- Name: idx_orders_restaurant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_created ON public.orders USING btree (restaurant_id, created_at DESC);


--
-- Name: idx_orders_restaurant_daily_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_daily_id ON public.orders USING btree (restaurant_id, daily_order_id);


--
-- Name: idx_orders_restaurant_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_delivery_status ON public.orders USING btree (restaurant_id, delivery_status) WHERE (delivery_status IS NOT NULL);


--
-- Name: idx_orders_restaurant_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_status_created ON public.orders USING btree (restaurant_id, status, created_at DESC);


--
-- Name: idx_orders_restaurant_today; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_today ON public.orders USING btree (restaurant_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'preparing'::text, 'ready'::text, 'completed'::text, 'saved'::text, 'served'::text]));


--
-- Name: idx_orders_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_scheduled ON public.orders USING btree (restaurant_id, scheduled_for) WHERE (is_scheduled = true);


--
-- Name: idx_org_audit_log_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_audit_log_org ON public.org_audit_log USING btree (organization_id);


--
-- Name: idx_org_audit_log_org_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_audit_log_org_action ON public.org_audit_log USING btree (organization_id, action);


--
-- Name: idx_org_menu_items_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_menu_items_org ON public.org_menu_items USING btree (organization_id);


--
-- Name: idx_org_menu_items_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_menu_items_template ON public.org_menu_items USING btree (template_id);


--
-- Name: idx_org_menu_templates_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_menu_templates_org ON public.org_menu_templates USING btree (organization_id);


--
-- Name: idx_owner_preferences_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_owner_preferences_user ON public.owner_preferences USING btree (user_id);


--
-- Name: idx_parking_configs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_configs_restaurant ON public.parking_configs USING btree (restaurant_id);


--
-- Name: idx_parking_rates_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_rates_restaurant ON public.parking_rates USING btree (restaurant_id);


--
-- Name: idx_parking_slots_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_slots_restaurant ON public.parking_slots USING btree (restaurant_id);


--
-- Name: idx_parking_slots_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_slots_zone ON public.parking_slots USING btree (zone_id);


--
-- Name: idx_parking_tickets_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_tickets_restaurant ON public.parking_tickets USING btree (restaurant_id);


--
-- Name: idx_parking_tickets_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_tickets_restaurant_status ON public.parking_tickets USING btree (restaurant_id, status);


--
-- Name: idx_parking_zones_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parking_zones_restaurant ON public.parking_zones USING btree (restaurant_id);


--
-- Name: idx_pay_slips_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pay_slips_restaurant ON public.pay_slips USING btree (restaurant_id);


--
-- Name: idx_pay_slips_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pay_slips_run ON public.pay_slips USING btree (run_id);


--
-- Name: idx_payroll_config_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_config_restaurant ON public.payroll_config USING btree (restaurant_id);


--
-- Name: idx_payroll_config_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_config_staff ON public.payroll_config USING btree (restaurant_id, staff_id);


--
-- Name: idx_payroll_runs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_runs_restaurant ON public.payroll_runs USING btree (restaurant_id);


--
-- Name: idx_phone_calls_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_calls_restaurant ON public.phone_calls USING btree (restaurant_id);


--
-- Name: idx_phone_calls_restaurant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_calls_restaurant_created ON public.phone_calls USING btree (restaurant_id, created_at DESC);


--
-- Name: idx_pms_bookings_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_bookings_guest ON public.pms_bookings USING btree (guest_id);


--
-- Name: idx_pms_bookings_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_bookings_hotel ON public.pms_bookings USING btree (hotel_id);


--
-- Name: idx_pms_guests_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_guests_hotel ON public.pms_guests USING btree (hotel_id);


--
-- Name: idx_pms_housekeeping_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_housekeeping_hotel ON public.pms_housekeeping USING btree (hotel_id);


--
-- Name: idx_pms_maintenance_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_maintenance_hotel ON public.pms_maintenance USING btree (hotel_id);


--
-- Name: idx_pms_rooms_hotel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pms_rooms_hotel ON public.pms_rooms USING btree (hotel_id);


--
-- Name: idx_pos_invoices_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_invoices_restaurant ON public.pos_invoices USING btree (restaurant_id);


--
-- Name: idx_pos_payments_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_payments_restaurant ON public.pos_payments USING btree (restaurant_id);


--
-- Name: idx_production_orders_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_production_orders_org ON public.production_orders USING btree (organization_id);


--
-- Name: idx_production_orders_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_production_orders_org_status ON public.production_orders USING btree (organization_id, status);


--
-- Name: idx_purchase_orders_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_restaurant ON public.purchase_orders USING btree (restaurant_id);


--
-- Name: idx_purchase_orders_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_restaurant_status ON public.purchase_orders USING btree (restaurant_id, status);


--
-- Name: idx_purchase_requisitions_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_requisitions_restaurant ON public.purchase_requisitions USING btree (restaurant_id);


--
-- Name: idx_query_cache_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_query_cache_restaurant ON public.query_cache USING btree (restaurant_id);


--
-- Name: idx_rag_knowledge_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rag_knowledge_restaurant ON public.rag_knowledge USING btree (restaurant_id);


--
-- Name: idx_razorpay_tokens_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_razorpay_tokens_restaurant ON public.razorpay_tokens USING btree (restaurant_id);


--
-- Name: idx_recipes_menu_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_menu_item ON public.recipes USING btree (restaurant_id, menu_item_id);


--
-- Name: idx_recipes_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_restaurant ON public.recipes USING btree (restaurant_id);


--
-- Name: idx_rest_booking_venues_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rest_booking_venues_restaurant ON public.rest_booking_venues USING btree (restaurant_id);


--
-- Name: idx_rest_bookings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rest_bookings_restaurant ON public.rest_bookings USING btree (restaurant_id);


--
-- Name: idx_rest_bookings_venue_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rest_bookings_venue_id ON public.rest_bookings USING btree (restaurant_id, ((venue ->> 'venueId'::text))) WHERE (venue IS NOT NULL);


--
-- Name: idx_restaurant_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurant_settings_restaurant ON public.restaurant_settings USING btree (restaurant_id);


--
-- Name: idx_restaurants_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_restaurants_code ON public.restaurants USING btree (restaurant_code) WHERE (restaurant_code IS NOT NULL);


--
-- Name: idx_restaurants_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_org ON public.restaurants USING btree (organization_id);


--
-- Name: idx_restaurants_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_owner ON public.restaurants USING btree (owner_id);


--
-- Name: idx_restaurants_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_parent ON public.restaurants USING btree (parent_restaurant_id) WHERE (parent_restaurant_id IS NOT NULL);


--
-- Name: idx_restaurants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_status ON public.restaurants USING btree (status);


--
-- Name: idx_restaurants_subdomain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_restaurants_subdomain ON public.restaurants USING btree (subdomain) WHERE (subdomain IS NOT NULL);


--
-- Name: idx_restaurants_talabat_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_talabat_vendor ON public.restaurants USING btree ((((aggregator_config -> 'talabat'::text) ->> 'vendorId'::text))) WHERE (aggregator_config IS NOT NULL);


--
-- Name: idx_restaurants_url_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_restaurants_url_slug ON public.restaurants USING btree (url_slug) WHERE (url_slug IS NOT NULL);


--
-- Name: idx_room_maintenance_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_maintenance_restaurant ON public.room_maintenance_schedules USING btree (restaurant_id);


--
-- Name: idx_room_maintenance_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_maintenance_room ON public.room_maintenance_schedules USING btree (restaurant_id, room_id);


--
-- Name: idx_sadad_merchant_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sadad_merchant_order ON public.sadad_transactions USING btree (merchant_order_no);


--
-- Name: idx_saved_carts_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_carts_active ON public.saved_carts USING btree (restaurant_id, is_active);


--
-- Name: idx_saved_carts_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_carts_restaurant ON public.saved_carts USING btree (restaurant_id);


--
-- Name: idx_saved_carts_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_carts_type ON public.saved_carts USING btree (restaurant_id, type);


--
-- Name: idx_shift_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shift_settings_restaurant ON public.restaurant_shift_settings USING btree (restaurant_id);


--
-- Name: idx_shifts_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_restaurant ON public.shifts USING btree (restaurant_id);


--
-- Name: idx_shifts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_status ON public.shifts USING btree (restaurant_id, status);


--
-- Name: idx_space_bookings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_space_bookings_restaurant ON public.space_bookings USING btree (restaurant_id);


--
-- Name: idx_staff_locations_latest_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_locations_latest_restaurant ON public.staff_locations_latest USING btree (restaurant_id);


--
-- Name: idx_staff_locations_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_locations_restaurant ON public.staff_locations USING btree (restaurant_id);


--
-- Name: idx_staff_shifts_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_shifts_date ON public.staff_shifts USING btree (restaurant_id, date);


--
-- Name: idx_staff_shifts_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_shifts_restaurant ON public.staff_shifts USING btree (restaurant_id);


--
-- Name: idx_staff_users_login_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_users_login_id ON public.staff_users USING btree (login_id);


--
-- Name: idx_staff_users_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_users_restaurant ON public.staff_users USING btree (restaurant_id);


--
-- Name: idx_stock_batches_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_batches_active ON public.stock_batches USING btree (restaurant_id, inventory_item_id, status) WHERE (status = 'active'::text);


--
-- Name: idx_stock_batches_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_batches_expiry ON public.stock_batches USING btree (expiry_date) WHERE (status = 'active'::text);


--
-- Name: idx_stock_batches_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_batches_item ON public.stock_batches USING btree (restaurant_id, inventory_item_id);


--
-- Name: idx_stock_batches_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_batches_restaurant ON public.stock_batches USING btree (restaurant_id);


--
-- Name: idx_stock_transfers_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_transfers_restaurant ON public.stock_transfers USING btree (restaurant_id);


--
-- Name: idx_subrest_rid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subrest_rid ON public.sub_restaurants USING btree (restaurant_id);


--
-- Name: idx_supplier_invoices_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_invoices_restaurant ON public.supplier_invoices USING btree (restaurant_id);


--
-- Name: idx_supplier_performance_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_performance_restaurant ON public.supplier_performance USING btree (restaurant_id);


--
-- Name: idx_supplier_returns_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_returns_restaurant ON public.supplier_returns USING btree (restaurant_id);


--
-- Name: idx_suppliers_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_restaurant ON public.suppliers USING btree (restaurant_id);


--
-- Name: idx_tables_floor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_floor ON public.tables USING btree (floor_id);


--
-- Name: idx_tables_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_restaurant ON public.tables USING btree (restaurant_id);


--
-- Name: idx_tables_restaurant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_restaurant_name ON public.tables USING btree (restaurant_id, name);


--
-- Name: idx_tables_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_restaurant_status ON public.tables USING btree (restaurant_id, status);


--
-- Name: idx_tax_settings_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_settings_restaurant ON public.tax_settings USING btree (restaurant_id);


--
-- Name: idx_token_usage_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_usage_restaurant ON public.token_usage USING btree (restaurant_id);


--
-- Name: idx_user_restaurants_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_restaurants_restaurant ON public.user_restaurants USING btree (restaurant_id);


--
-- Name: idx_user_restaurants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_restaurants_user ON public.user_restaurants USING btree (user_id);


--
-- Name: idx_user_restaurants_user_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_restaurants_user_restaurant ON public.user_restaurants USING btree (user_id, restaurant_id);


--
-- Name: idx_waste_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waste_entries_date ON public.waste_entries USING btree (restaurant_id, date DESC);


--
-- Name: idx_waste_entries_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waste_entries_item ON public.waste_entries USING btree (restaurant_id, item_id);


--
-- Name: idx_waste_entries_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waste_entries_restaurant ON public.waste_entries USING btree (restaurant_id);


--
-- Name: idx_whatsapp_config_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_config_restaurant ON public.whatsapp_ordering_config USING btree (restaurant_id);


--
-- Name: idx_whatsapp_logs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_logs_restaurant ON public.whatsapp_conversation_logs USING btree (restaurant_id);


--
-- Name: idx_whatsapp_order_logs_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_order_logs_restaurant ON public.whatsapp_order_logs USING btree (restaurant_id);


--
-- Name: bar_bottles bar_bottles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bar_bottles_updated_at BEFORE UPDATE ON public.bar_bottles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: daily_stats daily_stats_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daily_stats_updated_at BEFORE UPDATE ON public.daily_stats FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: floors floors_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER floors_updated_at BEFORE UPDATE ON public.floors FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: inventory inventory_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: orders orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recipes recipes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recipes_updated_at BEFORE UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: restaurants restaurants_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER restaurants_updated_at BEFORE UPDATE ON public.restaurants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: stock_batches stock_batches_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stock_batches_updated_at BEFORE UPDATE ON public.stock_batches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tables tables_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tables_updated_at BEFORE UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tables tables_floor_id_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_floor_id_restaurant_id_fkey FOREIGN KEY (floor_id, restaurant_id) REFERENCES public.floors(id, restaurant_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict GF6xWoXrEeJT0EtN9rTp2o9ODlBiMNdOkVQIgLuSEHB6sL2RVg3dDLrq9nKAwWn

