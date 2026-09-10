#!/usr/bin/env bash
#
# Deploy apps/api to Azure Container Apps.
#
# Everything is idempotent: run it once to create, run it again to ship a new revision. The
# image is built by ACR rather than locally, so this needs no Docker and works the same from a
# laptop or from CI.
#
#   az login
#   cp .env.deploy.example .env.deploy && $EDITOR .env.deploy
#   ./scripts/deploy-api.sh
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

[[ -f .env.deploy ]] && set -a && . ./.env.deploy && set +a

: "${AZ_RESOURCE_GROUP:=prep-kit}"
: "${AZ_LOCATION:=westeurope}"
: "${AZ_ACR:?Set AZ_ACR to a globally unique registry name, e.g. prepkit<something>}"
: "${AZ_ENV:=prep-kit-env}"
: "${AZ_APP:=prep-kit-api}"
: "${GEMINI_API_KEY:?Required. https://aistudio.google.com/apikey}"
: "${MONGODB_URI:?Required in production — the API refuses to start on the in-memory store.}"
: "${CLERK_ISSUER:?Required in production — e.g. https://your-app.clerk.accounts.dev}"
: "${TAVILY_API_KEY:=}"
: "${CORS_ORIGINS:=}"

tag="$(git rev-parse --short HEAD)$( git diff --quiet || echo -dirty )"
image="${AZ_ACR}.azurecr.io/prep-kit-api:${tag}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

say "Resource group ${AZ_RESOURCE_GROUP} in ${AZ_LOCATION}"
az group create -n "$AZ_RESOURCE_GROUP" -l "$AZ_LOCATION" -o none

say "Registry ${AZ_ACR}"
az acr show -n "$AZ_ACR" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null ||
  az acr create -n "$AZ_ACR" -g "$AZ_RESOURCE_GROUP" --sku Basic --admin-enabled true -o none

# Built in Azure from this working tree. The tag carries the commit, so a running revision can
# always be traced back to source — and `-dirty` says out loud when it cannot.
say "Building ${image}"
az acr build -r "$AZ_ACR" -t "prep-kit-api:${tag}" -f Dockerfile . -o none

say "Container Apps environment ${AZ_ENV}"
az containerapp env show -n "$AZ_ENV" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null ||
  az containerapp env create -n "$AZ_ENV" -g "$AZ_RESOURCE_GROUP" -l "$AZ_LOCATION" -o none

# Secrets are set every run so rotating a key is just editing .env.deploy and deploying again.
secrets=(
  "gemini-key=${GEMINI_API_KEY}"
  "mongodb-uri=${MONGODB_URI}"
)
env_vars=(
  "NODE_ENV=production"
  "PORT=8080"
  "GEMINI_API_KEY=secretref:gemini-key"
  "MONGODB_URI=secretref:mongodb-uri"
  "CLERK_ISSUER=${CLERK_ISSUER}"
  # Not a decision the deployment gets to make. Loopback and private addresses stay rejected in
  # production; only `npm run evaluate` turns this on, for itself, to reach its fixture server.
  "ALLOW_PRIVATE_HOSTS=false"
)
if [[ -n "$TAVILY_API_KEY" ]]; then
  secrets+=( "tavily-key=${TAVILY_API_KEY}" )
  env_vars+=( "TAVILY_API_KEY=secretref:tavily-key" )
fi
[[ -n "$CORS_ORIGINS" ]] && env_vars+=( "CORS_ORIGINS=${CORS_ORIGINS}" )

if az containerapp show -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null; then
  say "Updating ${AZ_APP}"
  az containerapp secret set -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" --secrets "${secrets[@]}" -o none
  az containerapp update -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" \
    --image "$image" --set-env-vars "${env_vars[@]}" -o none
else
  say "Creating ${AZ_APP}"
  az containerapp create -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" \
    --environment "$AZ_ENV" \
    --image "$image" \
    --registry-server "${AZ_ACR}.azurecr.io" \
    --target-port 8080 --ingress external \
    --cpu 1 --memory 2Gi \
    --secrets "${secrets[@]}" \
    --env-vars "${env_vars[@]}" \
    `# One replica, and never zero.` \
    `# A job's record and its spans live in the process that is running it. Two replicas and a` \
    `# poll can land on the one that has never heard of the job; zero replicas and a run dies` \
    `# the moment the browser tab that started it goes quiet. Persisting job state would lift` \
    `# this limit and is the first thing to do if the app ever needs to scale.` \
    --min-replicas 1 --max-replicas 1 \
    -o none
fi

fqdn="$(az containerapp show -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"

say "Deployed"
printf '  image   %s\n  url     https://%s\n\n' "$image" "$fqdn"
printf '  health  '; curl -fsS "https://${fqdn}/health" && printf '\n'
printf '\nSet this in Vercel, then redeploy the web app:\n\n  API_ORIGIN=https://%s\n\n' "$fqdn"
