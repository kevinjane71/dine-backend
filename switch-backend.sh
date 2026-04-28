#!/bin/bash

# ============================================================
# DineOpen Backend Switcher
# Switch between Vercel and GCP Cloud Run with one command
# ============================================================

PROJECT_ID="ascendant-idea-443107-f8"
REGION="asia-south1"
SERVICE_NAME="dine-backend"
CLOUD_RUN_URL="https://dine-backend-son5lc3cca-el.a.run.app"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get Cloud Run URL
get_cloud_run_url() {
  gcloud run services describe $SERVICE_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --format='value(status.url)' 2>/dev/null
}

# ── DEPLOY to Cloud Run (first time only) ──────────────────
deploy() {
  echo -e "${BLUE}🚀 Deploying dine-backend to Cloud Run...${NC}"

  cd "$(dirname "$0")"

  gcloud run deploy $SERVICE_NAME \
    --project=$PROJECT_ID \
    --source . \
    --region=$REGION \
    --min-instances=0 \
    --max-instances=3 \
    --memory=1Gi \
    --cpu=1 \
    --timeout=60 \
    --allow-unauthenticated \
    --set-env-vars="NODE_ENV=production" \
    --port=3003

  if [ $? -eq 0 ]; then
    CLOUD_RUN_URL=$(get_cloud_run_url)
    echo -e "${GREEN}✅ Deployed! URL: $CLOUD_RUN_URL${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  Now set env vars on Cloud Run:${NC}"
    echo "   Go to: https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME/variables?project=$PROJECT_ID"
    echo "   Or run: gcloud run services update $SERVICE_NAME --region=$REGION --set-env-vars-file=.env.production"
    echo ""
    echo -e "${YELLOW}⚠️  Cost: ₹0 when idle (scales to 0). Only pays when requests come in.${NC}"
  else
    echo -e "${RED}❌ Deploy failed${NC}"
    exit 1
  fi
}

# ── SWITCH to GCP ──────────────────────────────────────────
switch_to_gcp() {
  CLOUD_RUN_URL=$(get_cloud_run_url)

  if [ -z "$CLOUD_RUN_URL" ]; then
    echo -e "${RED}❌ Cloud Run service not found. Run './switch-backend.sh deploy' first.${NC}"
    exit 1
  fi

  echo -e "${BLUE}🔄 Switching frontend to GCP Cloud Run...${NC}"
  echo -e "   URL: $CLOUD_RUN_URL"

  # Wake up Cloud Run (it may be scaled to 0)
  echo -e "${YELLOW}⏳ Waking up Cloud Run...${NC}"
  gcloud run services update $SERVICE_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --min-instances=1 \
    --quiet

  # Update frontend env on Vercel
  echo "$CLOUD_RUN_URL" | vercel env add NEXT_PUBLIC_API_URL production --force 2>/dev/null || \
  echo -e "${YELLOW}⚠️  Update NEXT_PUBLIC_API_URL manually on Vercel frontend to: $CLOUD_RUN_URL${NC}"

  echo ""
  echo -e "${GREEN}✅ Switched to GCP!${NC}"
  echo -e "   Backend: $CLOUD_RUN_URL"
  echo -e "   ${YELLOW}Redeploy dine-frontend on Vercel to pick up the new URL.${NC}"
}

# ── SWITCH to Vercel ───────────────────────────────────────
switch_to_vercel() {
  VERCEL_URL="https://dine-backend-lake.vercel.app"

  echo -e "${BLUE}🔄 Switching frontend back to Vercel...${NC}"

  # Scale Cloud Run to 0 (stop paying)
  echo -e "${YELLOW}⏳ Scaling Cloud Run to 0 (idle = free)...${NC}"
  gcloud run services update $SERVICE_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --min-instances=0 \
    --quiet 2>/dev/null

  # Update frontend env on Vercel
  echo "$VERCEL_URL" | vercel env add NEXT_PUBLIC_API_URL production --force 2>/dev/null || \
  echo -e "${YELLOW}⚠️  Update NEXT_PUBLIC_API_URL manually on Vercel frontend to: $VERCEL_URL${NC}"

  echo ""
  echo -e "${GREEN}✅ Switched to Vercel!${NC}"
  echo -e "   Backend: $VERCEL_URL"
  echo -e "   Cloud Run scaled to 0 (₹0 cost)"
  echo -e "   ${YELLOW}Redeploy dine-frontend on Vercel to pick up the new URL.${NC}"
}

# ── STATUS ─────────────────────────────────────────────────
status() {
  echo -e "${BLUE}📊 Backend Status${NC}"
  echo "──────────────────────────────────"

  # Check Cloud Run
  CLOUD_RUN_URL=$(get_cloud_run_url)
  if [ -n "$CLOUD_RUN_URL" ]; then
    MIN_INSTANCES=$(gcloud run services describe $SERVICE_NAME \
      --project=$PROJECT_ID --region=$REGION \
      --format='value(spec.template.metadata.annotations["autoscaling.knative.dev/minScale"])' 2>/dev/null)

    if [ "$MIN_INSTANCES" = "0" ] || [ -z "$MIN_INSTANCES" ]; then
      echo -e "  GCP Cloud Run:  ${YELLOW}STANDBY${NC} (scaled to 0, ₹0 cost)"
    else
      echo -e "  GCP Cloud Run:  ${GREEN}ACTIVE${NC} (min $MIN_INSTANCES instance)"
    fi
    echo "  URL: $CLOUD_RUN_URL"
  else
    echo -e "  GCP Cloud Run:  ${RED}NOT DEPLOYED${NC}"
  fi

  echo "  Vercel:         https://dine-backend-lake.vercel.app"
  echo "──────────────────────────────────"
}

# ── HELP ───────────────────────────────────────────────────
usage() {
  echo ""
  echo "Usage: ./switch-backend.sh [command]"
  echo ""
  echo "Commands:"
  echo "  deploy       First-time deploy to Cloud Run"
  echo "  gcp          Switch to GCP Cloud Run (wakes it up)"
  echo "  vercel       Switch to Vercel (puts GCP to sleep)"
  echo "  status       Show current backend status"
  echo ""
  echo "Examples:"
  echo "  ./switch-backend.sh deploy    # One-time setup"
  echo "  ./switch-backend.sh gcp       # Vercel down? Switch to GCP"
  echo "  ./switch-backend.sh vercel    # Switch back, GCP goes idle (free)"
  echo "  ./switch-backend.sh status    # Check what's running"
  echo ""
}

# ── Main ───────────────────────────────────────────────────
case "${1}" in
  deploy)   deploy ;;
  gcp)      switch_to_gcp ;;
  vercel)   switch_to_vercel ;;
  status)   status ;;
  *)        usage ;;
esac
