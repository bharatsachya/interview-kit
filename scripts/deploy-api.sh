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
: "${MONGODB_URI:?Required in production — the API refuses to start on the in-memory store.}"
: "${CLERK_ISSUER:?Required in production — e.g. https://your-app.clerk.accounts.dev}"
: "${GEMINI_API_KEY:=}"
: "${OPENROUTER_API_KEY:=}"
: "${LLM_PROVIDER:=}"
: "${OPENROUTER_MODELS:=}"
: "${GEMINI_MODEL_QUALITY:=}"
: "${GEMINI_MODEL_FAST:=}"
: "${GEMINI_RPM:=}"
: "${GEMINI_TPM:=}"
# How long one model call may take before the next model in the list is tried. Empty uses the
# built-in 15s; raise it if the free models you are on need longer to write a full question set.
: "${LLM_REQUEST_TIMEOUT_MS:=}"
# Container Apps fixes the ratio at 1 vCPU : 2 GiB, so these move together.
#
# Measured on a real run rather than guessed. One kit costs ~1.0 CPU-second of actual work — the
# rest of its ~40 seconds is waiting on a model or a socket, which costs no compute — and peaks
# at ~56 MB of transient Cheerio DOM over a 70 MB idle process. The runner caps itself at two
# concurrent jobs (`jobs.ts`, `concurrency ?? 2`), so the ceiling is ~0.1 core sustained and
# ~182 MB resident, bursting to one core for the few hundred milliseconds of each page parse.
#
# 0.5 vCPU / 1 GiB is therefore ~5x headroom on both. Going higher buys nothing: Node runs this
# on one thread, so anything above 1 vCPU cannot be used at all, and the memory rides along with
# the CPU whether it is needed or not.
: "${AZ_CPU:=0.5}"
: "${AZ_MEMORY:=1Gi}"
: "${FAKE_LLM:=false}"
: "${FAKE_FETCH:=false}"
: "${TAVILY_API_KEY:=}"
: "${CORS_ORIGINS:=}"

# Which model the deployed API will actually call.
#
# Gemini used to be required here, which was wrong in a way that only showed up after the
# deployment was live: its free tier is a *daily cap* of roughly twenty requests per model, not a
# rate limit, and one kit costs six to eight calls. A link handed to a reviewer is out of quota
# after two or three generations and waiting does not help. OpenRouter's free models draw on a
# different bucket, so the deployment needs to be able to express that choice — `apps/api` has
# supported both providers since H8 and only this script did not.
#
# `LLM_PROVIDER` is always sent explicitly. `chooseProvider` prefers Gemini when the variable is
# empty and both keys are present, so a deployment that switched to OpenRouter while a Gemini
# secret was still set would silently keep calling the spent key.
if [[ "$FAKE_LLM" =~ ^(1|true|yes)$ ]]; then
  provider_label="fake (canned responses — no model is called)"
  LLM_PROVIDER=""
elif [[ -n "$LLM_PROVIDER" ]]; then
  provider_label="$LLM_PROVIDER (explicit — pinned to one provider)"
elif [[ -n "$GEMINI_API_KEY" && -n "$OPENROUTER_API_KEY" ]]; then
  # Both keys, no explicit choice: send it empty and let the API use both, Gemini first.
  #
  # This used to resolve to "gemini" here, and it had to: an empty variable meant "whichever
  # chooseProvider prefers", and a deployment that had moved to OpenRouter while a spent Gemini
  # secret lingered would silently keep calling the spent key. Empty now means something
  # specific — one model list spanning both providers — so naming one would switch the failover
  # off, which is the opposite of what having two keys is for.
  provider_label="gemini → openrouter (one chain across both)"
  LLM_PROVIDER=""
elif [[ -n "$GEMINI_API_KEY" ]]; then
  provider_label="gemini"
  LLM_PROVIDER="gemini"
elif [[ -n "$OPENROUTER_API_KEY" ]]; then
  provider_label="openrouter"
  LLM_PROVIDER="openrouter"
else
  echo "Set GEMINI_API_KEY or OPENROUTER_API_KEY in .env.deploy, or FAKE_LLM=true to deploy a" >&2
  echo "demo that calls no model at all. See docs/DEPLOYING.md — 'Known limitations'." >&2
  exit 1
fi

if [[ "$LLM_PROVIDER" == "openrouter" && -z "$OPENROUTER_API_KEY" ]]; then
  echo "LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is empty." >&2
  exit 1
fi
if [[ "$LLM_PROVIDER" == "gemini" && -z "$GEMINI_API_KEY" ]]; then
  echo "LLM_PROVIDER=gemini but GEMINI_API_KEY is empty." >&2
  exit 1
fi

tag="$(git rev-parse --short HEAD)$( git diff --quiet || echo -dirty )"
image="${AZ_ACR}.azurecr.io/prep-kit-api:${tag}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# Created only when missing. A resource group's location is metadata — it records where the
# group's own record lives, not where its contents run — and it cannot be changed afterwards, so
# `az group create` on an existing group in another region is a hard error rather than a no-op.
# Regions get revisited here more than one might expect: a subscription's allowed-region policy
# and Container Apps' per-region environment capacity do not have to agree, and when they don't
# the registry and the app end up in different places quite legitimately.
existing_rg_location="$(az group show -n "$AZ_RESOURCE_GROUP" --query location -o tsv 2>/dev/null || true)"
if [[ -z "$existing_rg_location" ]]; then
  say "Resource group ${AZ_RESOURCE_GROUP} in ${AZ_LOCATION}"
  az group create -n "$AZ_RESOURCE_GROUP" -l "$AZ_LOCATION" -o none
elif [[ "$existing_rg_location" == "$AZ_LOCATION" ]]; then
  say "Resource group ${AZ_RESOURCE_GROUP} in ${AZ_LOCATION}"
else
  say "Resource group ${AZ_RESOURCE_GROUP} (record in ${existing_rg_location}; deploying to ${AZ_LOCATION})"
fi

say "Registry ${AZ_ACR}"
az acr show -n "$AZ_ACR" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null ||
  az acr create -n "$AZ_ACR" -g "$AZ_RESOURCE_GROUP" --sku Basic --admin-enabled true -o none

# Built in Azure from this working tree. The tag carries the commit, so a running revision can
# always be traced back to source — and `-dirty` says out loud when it cannot.
#
# ACR Tasks is the preferred path because it needs no local Docker and builds natively on amd64.
# It is not available everywhere: an Azure for Students subscription refuses it outright with
# TasksOperationsNotAllowed, and no amount of retrying changes that. So the build falls back to
# the local daemon rather than the deployment simply being impossible on that kind of account.
#
# The fallback must cross-compile. Container Apps runs linux/amd64 and an Apple Silicon laptop
# builds linux/arm64 by default; an image of the wrong architecture pushes and deploys perfectly
# happily and then fails to start, which is a slow and confusing way to find out.
say "Building ${image}"
if [[ "${AZ_BUILD:-auto}" != "local" ]] && az acr build -r "$AZ_ACR" -t "prep-kit-api:${tag}" -f Dockerfile . -o none 2>/tmp/acr-build.$$; then
  build_where="ACR Tasks"
else
  if [[ "${AZ_BUILD:-auto}" != "local" ]]; then
    echo
    echo "  ACR Tasks unavailable on this subscription — building locally instead:" >&2
    sed 's/^/    /' /tmp/acr-build.$$ | head -3 >&2
    echo
  fi
  rm -f /tmp/acr-build.$$

  command -v docker >/dev/null || {
    echo "Local build needs Docker, and ACR Tasks is not available on this subscription." >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker is installed but its daemon is not running. Start it and run this again." >&2
    exit 1
  }

  say "Building locally for linux/amd64 (slower than ACR, and the only option here)"
  az acr login -n "$AZ_ACR" -o none
  docker buildx build --platform linux/amd64 -f Dockerfile -t "$image" --push .
  build_where="local docker (cross-compiled to amd64)"
fi
rm -f /tmp/acr-build.$$

say "Container Apps environment ${AZ_ENV}"
az containerapp env show -n "$AZ_ENV" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null ||
  az containerapp env create -n "$AZ_ENV" -g "$AZ_RESOURCE_GROUP" -l "$AZ_LOCATION" -o none

# Secrets are set every run so rotating a key is just editing .env.deploy and deploying again.
secrets=( "mongodb-uri=${MONGODB_URI}" )
env_vars=(
  "NODE_ENV=production"
  "PORT=8080"
  "MONGODB_URI=secretref:mongodb-uri"
  "CLERK_ISSUER=${CLERK_ISSUER}"
  "LLM_PROVIDER=${LLM_PROVIDER}"
  # Not a decision the deployment gets to make. Loopback and private addresses stay rejected in
  # production; only `npm run evaluate` turns this on, for itself, to reach its fixture server.
  "ALLOW_PRIVATE_HOSTS=false"
)

# A model key is a secret; the model *names* are not, and being able to set them is the one
# lever that widens Gemini's daily cap, since the cap is per model and both variables take a
# comma-separated list.
if [[ -n "$GEMINI_API_KEY" ]]; then
  secrets+=( "gemini-key=${GEMINI_API_KEY}" )
  env_vars+=( "GEMINI_API_KEY=secretref:gemini-key" )
fi
if [[ -n "$OPENROUTER_API_KEY" ]]; then
  secrets+=( "openrouter-key=${OPENROUTER_API_KEY}" )
  env_vars+=( "OPENROUTER_API_KEY=secretref:openrouter-key" )
fi
if [[ -n "$TAVILY_API_KEY" ]]; then
  secrets+=( "tavily-key=${TAVILY_API_KEY}" )
  env_vars+=( "TAVILY_API_KEY=secretref:tavily-key" )
fi

for pass_through in OPENROUTER_MODELS GEMINI_MODEL_QUALITY GEMINI_MODEL_FAST GEMINI_RPM GEMINI_TPM LLM_REQUEST_TIMEOUT_MS CORS_ORIGINS; do
  [[ -n "${!pass_through}" ]] && env_vars+=( "${pass_through}=${!pass_through}" )
done

# Deliberate, and loud about it. A deployment that calls no model always works and researches
# nothing real — a legitimate choice for a demo link, and one to state out loud rather than let
# someone discover from a brief that reads the same for every company.
if [[ "$FAKE_LLM" =~ ^(1|true|yes)$ ]]; then env_vars+=( "FAKE_LLM=true" ); fi
if [[ "$FAKE_FETCH" =~ ^(1|true|yes)$ ]]; then env_vars+=( "FAKE_FETCH=true" ); fi

if az containerapp show -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" -o none 2>/dev/null; then
  # Note for anyone changing only an environment variable: do not reach for `az containerapp
  # update --set-env-vars` on its own. On an Express environment that updates the app definition
  # without replacing the running replica — the process restarts inside the existing pod, which
  # keeps the environment it was created with, so the change appears to apply and does nothing.
  # `--revision-suffix`, the usual way to force a roll, is rejected outright on Express. A new
  # image tag is what actually replaces the pod, which is why this path always ships one.
  say "Updating ${AZ_APP}"
  az containerapp secret set -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" --secrets "${secrets[@]}" -o none
  az containerapp update -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" \
    --image "$image" --set-env-vars "${env_vars[@]}" \
    `# Sizing is re-applied on every run, not only at create. It was create-only, which meant` \
    `# changing AZ_CPU did nothing to an app that already existed and said nothing about it.` \
    --cpu "$AZ_CPU" --memory "$AZ_MEMORY" -o none
else
  say "Creating ${AZ_APP}"
  az containerapp create -n "$AZ_APP" -g "$AZ_RESOURCE_GROUP" \
    --environment "$AZ_ENV" \
    --image "$image" \
    --registry-server "${AZ_ACR}.azurecr.io" \
    --target-port 8080 --ingress external \
    --cpu "$AZ_CPU" --memory "$AZ_MEMORY" \
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
printf '  image   %s\n  built   %s\n  size    %s vCPU / %s\n  url     https://%s\n  model   %s\n  search  %s\n\n' \
  "$image" "$build_where" "$AZ_CPU" "$AZ_MEMORY" "$fqdn" "$provider_label" "$([[ -n "$TAVILY_API_KEY" ]] && echo tavily || echo 'none — the discussion step records itself as skipped')"
printf '  health  '; curl -fsS "https://${fqdn}/health" && printf '\n'
printf '\nSet this in Vercel, then redeploy the web app:\n\n  API_ORIGIN=https://%s\n\n' "$fqdn"
