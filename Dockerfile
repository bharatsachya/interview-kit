# ─────────────────────────────────────────────────────────────────────────────
# apps/api — the Express API and the pipeline behind it.
#
# The build context is the repo root, not apps/api. No @trao package publishes a `main` or an
# `exports` field, by design: the dependency rule is enforced through tsconfig paths rather than
# through node_modules, so the packages cannot be resolved in isolation. The API is the whole
# workspace minus the web app.
#
#   docker build -t prep-kit-api .
#   docker run --rm -p 8080:8080 --env-file .env prep-kit-api
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS deps

WORKDIR /app

# Only the manifests, so a change to source code does not reinstall node_modules. Every
# workspace package.json is needed for `npm ci` to resolve the workspace graph — including the
# web app's, which is why it is copied and then never used.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/auth/package.json packages/auth/
COPY packages/contracts/package.json packages/contracts/
COPY packages/coverage/package.json packages/coverage/
COPY packages/extraction/package.json packages/extraction/
COPY packages/generation/package.json packages/generation/
COPY packages/kernel/package.json packages/kernel/
COPY packages/kit/package.json packages/kit/
COPY packages/llm/package.json packages/llm/
COPY packages/persistence/package.json packages/persistence/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/practice/package.json packages/practice/
COPY packages/research/package.json packages/research/
COPY packages/retrieval/package.json packages/retrieval/
COPY packages/scheduling/package.json packages/scheduling/

# Named workspaces rather than `--workspaces`: the web app's dependency tree is the larger half
# of this repo and none of it belongs in an API image. The list is the API plus every package
# that declares a runtime dependency — the rest are pure TypeScript with nothing to install.
#
# `tsx` is a dependency of `apps/api`, not a root devDependency, precisely so `--omit=dev` keeps
# it: it is how this image runs.
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root \
      -w @trao/api \
      -w @trao/auth \
      -w @trao/extraction \
      -w @trao/generation \
      -w @trao/kit \
      -w @trao/persistence \
      -w @trao/retrieval

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
# Azure Container Apps sets this from the ingress config; the default matches the local one.
ENV PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY scripts ./scripts
# The fake provider's canned responses and the fixture sites. Small, and they are what makes
# FAKE_LLM=true a working deployment rather than a broken one.
COPY fixtures ./fixtures

# Not root. The process opens outbound HTTP to arbitrary company sites; it should not also be
# able to write to its own image.
USER node

EXPOSE 8080

# `tsx` rather than a compiled bundle. The repo has no emit step — `npm run build` is a
# typecheck — because the dependency rule lives in tsconfig paths and every consumer resolves
# TypeScript source. Adding a bundler here would introduce a second, divergent module graph for
# no gain at this size. Typechecking happens in CI, before the image is built.
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
