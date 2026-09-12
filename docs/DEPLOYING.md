# Deploying

Two deployments, because the two halves have different shapes. The web app is request/response
and belongs on a CDN-backed host; the API holds long-running jobs, opens outbound connections to
arbitrary company sites, and must not be restarted mid-run.

```
  browser
    │  same-origin, Clerk session cookie
    ▼
  Vercel — apps/web (Next.js)
    │  server-side fetch, Clerk JWT in an Authorization header
    ▼
  Azure Container Apps — apps/api (Express)
    ├── Gemini      generation
    ├── Tavily      public-discussion search (optional)
    └── MongoDB Atlas   kits and jobs
```

**The browser never talks to the API.** Everything under `apps/web/src/app/api/` forwards to it
server-side through `lib/api/upstream.ts`. Two reasons, and the second is the one that settles
it:

1. Same-origin requests need no CORS policy and no public API hostname in client code.
2. `EventSource` cannot set an `Authorization` header. A browser watching a job directly would
   have to put its session token in a query string, which puts it in every access log between
   here and Azure. Proxying keeps the token server-side.

The API still verifies every token itself, against Clerk's JWKS. It does not trust the web app
to have authenticated anyone — an API that believes a header because the frontend promises to
set one is authenticated only to people who use the frontend.

---

## What production requires, and what happens without it

`apps/api` **refuses to start** under `NODE_ENV=production` without both of these, and
`scripts/deploy-api.sh` refuses to deploy without a model key or an explicit `FAKE_LLM=true`:

| Variable | Without it | Why it is a refusal and not a warning |
|---|---|---|
| `MONGODB_URI` | in-memory store | Every kit vanishes on the next revision. Silent data loss is worse than a failed deploy. |
| `CLERK_ISSUER` | `DevAuthenticator` — the bearer token *is* the user id | An auth bypass a stray environment variable can switch on is not a bypass, it is a vulnerability. |

Locally both are optional and the API prints what it fell back to on startup.

---

## 1. MongoDB Atlas

Free tier (M0), any provider and region — put it near the Container App.

Network access must allow `0.0.0.0/0`. Container Apps replicas have no stable outbound address
unless the environment sits on a VNet with a NAT gateway, which neither product's free tier
justifies. The connection string is the credential; treat it as one.

```
mongodb+srv://user:pass@cluster.mongodb.net/prep-kit?retryWrites=true&w=majority
```

## 2. Clerk

One instance serves both halves. The web app needs the publishable and secret keys; the API
needs only the issuer, because it verifies tokens rather than minting them.

`CLERK_ISSUER` is the `iss` claim on a session token:

* development instance — `https://<slug>.clerk.accounts.dev`
* production instance — `https://clerk.<your-domain>`

Development keys work on any origin and are fine for a demo. They rate-limit and they show
Clerk's development banner; a production instance needs a custom domain.

## 3. The API on Azure Container Apps

```bash
az login
cp .env.deploy.example .env.deploy   # gitignored
$EDITOR .env.deploy                  # AZ_ACR must be globally unique
./scripts/deploy-api.sh
```

Idempotent: the first run creates the resource group, registry, environment and app; every run
after that builds a new image and ships a revision. The image is built by ACR, so this needs no
local Docker and behaves the same from CI.

The image tag is the commit sha, with `-dirty` appended when the working tree is not clean — a
running revision can always be traced back to source, and says so when it cannot.

The script prints the API's URL and its `/health` response at the end.

### One replica, and never zero

```
--min-replicas 1 --max-replicas 1
```

A job's record and its spans live in the process running it. Two replicas and a poll can land on
the one that has never heard of the job; zero replicas and a run dies the moment the browser tab
that started it goes quiet. Scale-to-zero would also cold-start a container on every first
request.

Persisting job state to Mongo — spans included — is what lifts this, and is the first thing to
do if the app ever needs to scale. It is not done: the kit is persisted, the trace is not.

### Deploying from CI

`.github/workflows/ci.yml` ships a revision on every push to `main` that touches the image, once
every gate has passed. Two properties are deliberate:

* **It waits for `/health`.** A revision that starts and then crashes is a deployment that
  reported success — the API refuses to boot without `MONGODB_URI` or `CLERK_ISSUER` and dies on
  an unreachable Atlas, and both have happened here. The job fails if nothing answers.
* **A web-only commit does not deploy.** Rolling the pod kills whatever generation is in flight,
  because `--min-replicas 1` exists precisely so job state can live in the process. `apps/web`
  deploys itself on Vercel and has no business restarting Azure.

Setup is one credential and three variables:

```bash
az ad sp create-for-rbac --name prep-kit-ci --role Contributor \
  --scopes "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/prep-kit" \
  --json-auth
```

Scoped to the one resource group rather than the subscription: it needs to push to the registry
and update the app, and nothing else. Put the JSON in the repository secret `AZURE_CREDENTIALS`,
and set the repository *variables* `AZ_ACR`, `AZ_RESOURCE_GROUP` and `AZ_APP` — those are names,
not secrets, and a workflow log that shows which registry it pushed to is easier to debug.

ACR Tasks is not used. An Azure for Students subscription refuses it outright
(`TasksOperationsNotAllowed`), so both the script and the workflow build with Docker — the
runner natively on amd64, a laptop by cross-compiling.

### Building the image yourself

```bash
docker build -t prep-kit-api .
docker run --rm -p 8080:8080 -e FAKE_LLM=true -e FAKE_FETCH=true prep-kit-api
```

The build context is the repo root, not `apps/api`. No `@trao` package publishes a `main` or
`exports` field — the dependency rule is enforced through tsconfig paths, not through
node_modules — so the packages cannot be resolved in isolation. The image runs TypeScript
directly under `tsx` for the same reason: the repo has no emit step, `npm run build` is a
typecheck, and adding a bundler would introduce a second, divergent module graph. Typechecking
happens before the image is built, not inside it.

With `FAKE_LLM=true FAKE_FETCH=true` the container runs the whole pipeline against canned
responses and the fixture sites — no key, no network, about a second. That is the fastest way to
prove an image is good.

## 4. The web app on Vercel

Import the repo and set **Root Directory** to `apps/web`. Leave "Include files outside the root
directory" on — the app compiles TypeScript source from `packages/` through
`transpilePackages`, so the build genuinely needs the rest of the repo.

Environment variables:

| Variable | Value |
|---|---|
| `API_ORIGIN` | `https://<app>.<region>.azurecontainerapps.io` — printed by the deploy script |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | from Clerk |
| `CLERK_SECRET_KEY` | from Clerk |

`API_ORIGIN` is deliberately **not** `NEXT_PUBLIC_`. Nothing in the browser learns the API's
address.

Then set `CORS_ORIGINS` on the Azure side to the Vercel origin and redeploy the API. It is belt
and braces — server-to-server calls carry no `Origin` header, so CORS never applies to the
traffic that matters — but it stops a stray page from making a browser call the API at all.

### The stream and function limits

`/api/jobs/:id/stream` polls the API and re-emits server-sent events. Vercel kills a function at
its plan's `maxDuration`; `apps/web/vercel.json` sets it to 60 seconds, the Hobby maximum, and
the route ends itself at 55 so it hands over deliberately rather than being cut mid-event.

The client reconnects once and then falls back to polling `/api/jobs/:id` every two seconds. Both
transports return the same shapes, so the state is identical either way and neither is the "real"
one. On a 90-second generation the stream covers most of the run and polling covers the rest.

---

## Verifying a deployment

```bash
curl -s https://<api-host>/health                       # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://<web-host>/api/kits   # 401 — JSON, not a redirect
az containerapp logs show -n prep-kit-api -g prep-kit --follow
```

The API's startup lines say what it actually resolved, and are the first thing to read when a
deployment behaves unexpectedly:

```
api listening on :8080
  auth      clerk
  store     mongodb
  model     gemini
  fetch     live
  search    tavily
```

---

## Known limitations

**Gemini's free tier is a daily cap, not a rate limit** — roughly 20 requests per day per model.
One kit costs six to eight model calls, so a free-tier key supports about **two or three
generations per day** across all users of the deployed link. The gateway's RPM and TPM buckets do
not help with this; nothing does except a paid key. A demo link left open to the public will be
out of quota by the time anyone else opens it.

`GEMINI_MODEL_QUALITY` and `GEMINI_MODEL_FAST` each take a comma-separated list, and the cap is
per model, so listing more models buys more headroom. `scripts/deploy-api.sh` passes both through.

**The real answer is more providers.** Set `ZAI_API_KEY` (https://z.ai/manage-apikey/apikey-list)
and `OPENROUTER_API_KEY` (free, no card, https://openrouter.ai/keys) in `.env.deploy`. Both are
metered separately from Gemini, and with several keys set the model list spans all of them —
Gemini → Z.AI → OpenRouter — so a run that hits the daily wall mid-kit continues rather than
failing. `LLM_PROVIDER` still pins one, and the deploy script always sends it explicitly, so a
secret left over from an earlier revision cannot silently win the choice back.

Setting `FAKE_LLM=true` on the deployed API turns the link into a demo that always works and
never researches anything real — a legitimate choice for a graded submission, and one to state
out loud rather than let someone discover. The deploy script reports which of the three it used
on every run.

**Traces are not persisted.** They live in the API process, which is why the app runs on a single
replica. A revision deployed mid-run loses that run's spans; the kit itself is already in Mongo.

**The CI deploy ships the image, and only the image.** Environment variables and secrets are set
on the Container App by `scripts/deploy-api.sh` from a local `.env.deploy`, and the workflow does
not re-apply them — a second copy of `MONGODB_URI`, `CLERK_ISSUER` and three API keys living in
GitHub is a wider blast radius than the convenience is worth. **Changing a variable still means
running the script once by hand**; changing code does not.

**Prompt injection is mitigated, not solved.** The API fetches arbitrary company pages and puts
their text in front of a model. Fetched content is fenced and labelled as data, and the model is
never allowed to decide schedule allocation, coverage gaps, link ranking, or requirement ids — so
the damage a hostile page can do is bounded by what generation controls. It is not zero.
