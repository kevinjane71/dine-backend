# GCP Deployment Guide for Dine Backend

## Quick Start

### 1. Prerequisites

```bash
# Install Google Cloud SDK
# macOS
brew install google-cloud-sdk

# Or download from: https://cloud.google.com/sdk/docs/install

# Login
gcloud auth login

# Install Docker (if not already installed)
# macOS
brew install docker
```

### 2. Initial Setup

```bash
# Create GCP project
gcloud projects create dine-backend-gcp --name="Dine Backend GCP"

# Set as default
gcloud config set project dine-backend-gcp

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable redis.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

### 3. Setup Redis (Memorystore)

```bash
# Create Redis instance (takes ~10-15 minutes)
gcloud redis instances create dine-redis \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_7_0 \
  --tier=basic

# Get Redis IP (save this for later)
gcloud redis instances describe dine-redis --region=us-central1 --format="value(host)"
```

### 4. Install Redis Client

```bash
cd dine-backend
npm install redis
```

### 5. Initialize Redis in Code

Add to `index.js` (after Firebase initialization):

```javascript
const { initRedis } = require('./services/redis');

// Initialize Redis (non-blocking)
initRedis().catch(console.error);
```

### 6. Deploy

#### Option A: Using Deployment Script

```bash
# Make script executable
chmod +x gcp-deploy.sh

# Set environment variables
export GCP_PROJECT_ID="dine-backend-gcp"
export REDIS_INSTANCE_NAME="dine-redis"

# Deploy
./gcp-deploy.sh
```

#### Option B: Manual Deployment

```bash
# Build and push
docker build -t gcr.io/dine-backend-gcp/dine-backend:latest .
docker push gcr.io/dine-backend-gcp/dine-backend:latest

# Deploy
gcloud run deploy dine-backend \
  --image gcr.io/dine-backend-gcp/dine-backend:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --port 8080
```

### 7. Set Environment Variables

```bash
# Get Redis IP
REDIS_IP=$(gcloud redis instances describe dine-redis --region=us-central1 --format="value(host)")

# Set environment variables
gcloud run services update dine-backend \
  --region us-central1 \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "REDIS_HOST=$REDIS_IP" \
  --set-env-vars "REDIS_PORT=6379" \
  --set-env-vars "FIREBASE_PROJECT_ID=your-project-id" \
  --set-env-vars "JWT_SECRET=your-jwt-secret"
```

### 8. Use Secret Manager (Recommended for Sensitive Data)

```bash
# Create secrets
echo -n "your-firebase-private-key" | gcloud secrets create firebase-private-key --data-file=-
echo -n "your-jwt-secret" | gcloud secrets create jwt-secret --data-file=-
echo -n "your-openai-key" | gcloud secrets create openai-api-key --data-file=-

# Grant Cloud Run access
gcloud secrets add-iam-policy-binding firebase-private-key \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Update service to use secrets
gcloud run services update dine-backend \
  --region us-central1 \
  --update-secrets FIREBASE_PRIVATE_KEY=firebase-private-key:latest,JWT_SECRET=jwt-secret:latest,OPENAI_API_KEY=openai-api-key:latest
```

## Environment Variables

### Required Variables

- `FIREBASE_PROJECT_ID` - Firebase project ID
- `FIREBASE_PRIVATE_KEY` - Firebase private key (use Secret Manager)
- `FIREBASE_CLIENT_EMAIL` - Firebase client email
- `JWT_SECRET` - JWT secret key (use Secret Manager)

### Optional Variables

- `REDIS_HOST` - Redis host IP (from Memorystore)
- `REDIS_PORT` - Redis port (default: 6379)
- `REDIS_PASSWORD` - Redis password (not needed for Memorystore)
- `OPENAI_API_KEY` - OpenAI API key (use Secret Manager)
- `RAZORPAY_KEY_ID` - Razorpay key ID
- `RAZORPAY_KEY_SECRET` - Razorpay key secret (use Secret Manager)

## Testing

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe dine-backend --region=us-central1 --format="value(status.url)")

# Test health endpoint
curl $SERVICE_URL/health

# Test API
curl $SERVICE_URL/api/restaurants
```

## Monitoring

```bash
# View logs
gcloud logging read "resource.type=cloud_run_revision" --limit 50

# View service details
gcloud run services describe dine-backend --region=us-central1

# View metrics
gcloud monitoring dashboards list
```

## Troubleshooting

### Redis Connection Issues

```bash
# Check Redis instance status
gcloud redis instances describe dine-redis --region=us-central1

# Test from Cloud Run (if VPC connector is set up)
gcloud run services proxy dine-backend --region=us-central1
```

### Cold Start Issues

```bash
# Set minimum instances to avoid cold starts
gcloud run services update dine-backend \
  --region us-central1 \
  --min-instances 1
```

### Environment Variables Not Working

```bash
# Check current env vars
gcloud run services describe dine-backend --region=us-central1 --format="value(spec.template.spec.containers[0].env)"

# Check IAM permissions
gcloud projects get-iam-policy dine-backend-gcp
```

## Cost Optimization

1. **Scale to Zero**: Cloud Run scales to zero when not in use (default)
2. **Right-sizing**: Adjust memory/CPU based on usage
3. **Redis Tier**: Use basic tier for development, standard for production
4. **Monitoring**: Set up alerts for unexpected costs

## Next Steps

1. Set up CI/CD with GitHub Actions (see `.github/workflows/deploy-gcp.yml`)
2. Configure custom domain
3. Set up Cloud CDN for caching
4. Enable Cloud Armor for DDoS protection
5. Set up monitoring and alerts

## Resources

- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Memorystore for Redis](https://cloud.google.com/memorystore/docs/redis)
- [Secret Manager](https://cloud.google.com/secret-manager/docs)
- [Cloud Build](https://cloud.google.com/build/docs)

