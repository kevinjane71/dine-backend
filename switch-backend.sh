#!/bin/bash

# ============================================================
# DineOpen Backend Switcher
# Switch between Vercel and GCP Cloud Run with one command
# Automatically updates frontend env var + triggers redeploy
# ============================================================

PROJECT_ID="ascendant-idea-443107-f8"
REGION="asia-south1"
SERVICE_NAME="dine-backend"
CLOUD_RUN_URL="https://dine-backend-son5lc3cca-el.a.run.app"
VERCEL_URL="https://dine-backend-lake.vercel.app"
FRONTEND_DIR="$(dirname "$0")/../dine-frontend"

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

# Update frontend NEXT_PUBLIC_API_URL via Vercel API
update_frontend_env() {
  local NEW_URL=$1

  echo -e "${YELLOW}  Updating NEXT_PUBLIC_API_URL on Vercel...${NC}"

  VERCEL_TOKEN=$(cat "$HOME/Library/Application Support/com.vercel.cli/auth.json" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

  if [ -z "$VERCEL_TOKEN" ]; then
    echo -e "${YELLOW}  Could not find Vercel token. Update NEXT_PUBLIC_API_URL manually to: $NEW_URL${NC}"
    return 1
  fi

  VERCEL_SCOPE="kapils-projects-bfc8fbae"
  PROJECT_ID_VERCEL="prj_kCZTDodRMpDnyNco7xvFlauxHyYr"
  ENV_ID="6pv92eX9mLHzOxpR"

  curl -s -X PATCH -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"value\": \"$NEW_URL\"}" \
    "https://api.vercel.com/v10/projects/$PROJECT_ID_VERCEL/env/$ENV_ID?teamId=$VERCEL_SCOPE" > /dev/null

  echo -e "${GREEN}  Updated NEXT_PUBLIC_API_URL = $NEW_URL${NC}"
}

# Trigger frontend redeploy via git push
trigger_frontend_redeploy() {
  local MSG=$1

  echo -e "${YELLOW}  Triggering frontend redeploy via git push...${NC}"

  cd "$FRONTEND_DIR" || { echo -e "${RED}  dine-frontend folder not found${NC}"; return 1; }

  # Update trigger file with timestamp
  echo "$MSG $(date +%s)" > .deploy-trigger

  git add .deploy-trigger
  git commit -m "$MSG" --quiet
  git push origin main --quiet 2>&1

  if [ $? -eq 0 ]; then
    echo -e "${GREEN}  Pushed to main. Vercel will auto-deploy.${NC}"
  else
    echo -e "${RED}  Git push failed. Push manually or redeploy from Vercel dashboard.${NC}"
  fi

  cd - > /dev/null
}

# ── DEPLOY to Cloud Run (first time or code update) ────────
deploy() {
  echo -e "${BLUE}Deploying dine-backend to Cloud Run...${NC}"

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
    echo -e "${GREEN}Deployed! URL: $CLOUD_RUN_URL${NC}"
    echo -e "${YELLOW}Cost: free when idle (scales to 0). Only pays when requests come in.${NC}"
  else
    echo -e "${RED}Deploy failed${NC}"
    exit 1
  fi
}

# ── SWITCH to GCP ──────────────────────────────────────────
switch_to_gcp() {
  CLOUD_RUN_URL=$(get_cloud_run_url)

  if [ -z "$CLOUD_RUN_URL" ]; then
    echo -e "${RED}Cloud Run service not found. Run './switch-backend.sh deploy' first.${NC}"
    exit 1
  fi

  echo -e "${BLUE}Switching to GCP Cloud Run...${NC}"
  echo -e "   URL: $CLOUD_RUN_URL"
  echo ""

  # Step 1: Wake up Cloud Run
  echo -e "${YELLOW}[1/3] Waking up Cloud Run (min-instances=1)...${NC}"
  gcloud run services update $SERVICE_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --min-instances=1 \
    --quiet

  # Step 2: Update env var on Vercel
  echo -e "${YELLOW}[2/3] Updating frontend env var...${NC}"
  update_frontend_env "$CLOUD_RUN_URL"

  # Step 3: Trigger redeploy
  echo -e "${YELLOW}[3/3] Triggering frontend redeploy...${NC}"
  trigger_frontend_redeploy "switch backend to gcp"

  echo ""
  echo -e "${GREEN}Done! Switched to GCP.${NC}"
  echo -e "   Backend: $CLOUD_RUN_URL"
  echo -e "   Frontend will be live in ~2 min after Vercel build."
}

# ── SWITCH to Vercel ───────────────────────────────────────
switch_to_vercel() {
  echo -e "${BLUE}Switching to Vercel...${NC}"
  echo ""

  # Step 1: Scale Cloud Run to 0
  echo -e "${YELLOW}[1/3] Scaling Cloud Run to 0 (idle = free)...${NC}"
  gcloud run services update $SERVICE_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --min-instances=0 \
    --quiet 2>/dev/null

  # Step 2: Update env var on Vercel
  echo -e "${YELLOW}[2/3] Updating frontend env var...${NC}"
  update_frontend_env "$VERCEL_URL"

  # Step 3: Trigger redeploy
  echo -e "${YELLOW}[3/3] Triggering frontend redeploy...${NC}"
  trigger_frontend_redeploy "switch backend to vercel"

  echo ""
  echo -e "${GREEN}Done! Switched to Vercel.${NC}"
  echo -e "   Backend: $VERCEL_URL"
  echo -e "   Cloud Run scaled to 0 (free)"
  echo -e "   Frontend will be live in ~2 min after Vercel build."
}

# ── STATUS ─────────────────────────────────────────────────
status() {
  echo -e "${BLUE}Backend Status${NC}"
  echo "──────────────────────────────────"

  CLOUD_RUN_URL=$(get_cloud_run_url)
  if [ -n "$CLOUD_RUN_URL" ]; then
    MIN_INSTANCES=$(gcloud run services describe $SERVICE_NAME \
      --project=$PROJECT_ID --region=$REGION \
      --format='value(spec.template.metadata.annotations["autoscaling.knative.dev/minScale"])' 2>/dev/null)

    if [ "$MIN_INSTANCES" = "0" ] || [ -z "$MIN_INSTANCES" ]; then
      echo -e "  GCP Cloud Run:  ${YELLOW}STANDBY${NC} (scaled to 0, free)"
    else
      echo -e "  GCP Cloud Run:  ${GREEN}ACTIVE${NC} (min $MIN_INSTANCES instance)"
    fi
    echo "  URL: $CLOUD_RUN_URL"
  else
    echo -e "  GCP Cloud Run:  ${RED}NOT DEPLOYED${NC}"
  fi

  echo "  Vercel:         $VERCEL_URL"
  echo "──────────────────────────────────"
}

# ── HELP ───────────────────────────────────────────────────
usage() {
  echo ""
  echo "Usage: ./switch-backend.sh [command]"
  echo ""
  echo "Commands:"
  echo "  deploy       Deploy/redeploy to Cloud Run"
  echo "  gcp          Switch to GCP (wake up + update env + git push redeploy)"
  echo "  vercel       Switch to Vercel (GCP sleeps + update env + git push redeploy)"
  echo "  status       Show current backend status"
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
