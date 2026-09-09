# Running it without a browser

Everything below works from a clean clone. Nothing here needs the frontend.

```bash
npm ci
```

---

## 1. The one command that checks everything

```bash
npm run smoke
```

No API key, no network, about a second. Seven scenarios — a rich posting, the coverage second
pass, a sparse site, a two-line stub, Appendix B's sub-path shape, an unreachable site, and the
60-day schedule — each validated against Appendix A, plus the batch command validated against
Appendix B. It prints the span tree for every one and exits non-zero if anything is wrong.

Run this after changing anything in the pipeline.

---

## 2. One kit, with the trace

```bash
npm run dev:kit -- \
  --jd fixtures/jds/senior-backend.txt \
  --url https://meridian.test/ \
  --days 5 \
  --fake-llm --fake-fetch \
  --trace-pretty \
  --out tmp/kit.json
```

| Flag | Effect |
|---|---|
| `--jd <file\|->` | job description from a file, or `-` for stdin |
| `--url`, `--days` | company site, days until the interview |
| `--fake-llm` | canned responses — no key, no quota |
| `--fake-fetch` | serve pages from `fixtures/sites/` |
| `--no-cache` | bypass the cache, to prove a cold run works |
| `--trace-pretty` | print the span tree to **stderr** |
| `--trace <file>` | write the spans as JSON |
| `--out <file>` | write the kit JSON (default: stdout) |

The kit goes to stdout and everything else to stderr, so `--out` is optional:
`npm run dev:kit -- … --fake-llm --fake-fetch 2>/dev/null | jq .schedule`

---

## 3. The batch command

```bash
npm run evaluate -- --input fixtures/cases.json --output kits.json --fake-llm --fake-fetch
```

Drop the two `--fake-*` flags for a real run. Five fixture cases; the fifth points at a dead site
and comes back `failed: COMPANY_UNREACHABLE`, which is Appendix B's own worked example.

---

## 4. The API, without the web app

```bash
npm run api:fake      # port 8080, no key, no database, fixture sites
```

```bash
curl -s localhost:8080/health

JOB=$(curl -s -X POST localhost:8080/kits \
  -H 'authorization: Bearer alice' -H 'content-type: application/json' \
  -d '{"jd":"Senior Backend Engineer\n\nRequired:\n- 5+ years of Python\n","company_url":"https://meridian.test/","days":5}' \
  | jq -r '.job_ids[0]')

curl -s localhost:8080/jobs/$JOB -H 'authorization: Bearer alice' | jq '.job.status, .job.kitId'
curl -s localhost:8080/kits/$KIT -H 'authorization: Bearer alice' | jq '.kit.schedule'
```

With `FAKE_LLM` unset it uses the real Gemini. With `CLERK_ISSUER` unset it uses a dev
authenticator where the bearer token *is* the user id — which is why `Bearer alice` works above.
The API refuses to start in that mode when `NODE_ENV=production`.

---

## Where the traces are

Three places, all the same `Span[]`:

1. **`--trace-pretty`** — the span tree on stderr. This is the one to screenshot.
2. **`--trace <file>`** or `tmp/traces/*.json` from `npm run smoke` — the raw spans.
3. **`GET /jobs/:id`** — returns `{ job, spans, label }`. The progress screen reads its step
   names from exactly this, rather than from a hardcoded list.

What to look for:

```
▸ crawl_site        pages_fetched=4 robots_blocked=3 top_links=[…/handbook/hiring=15, …]
  ← link ranking ran in code, and the scores say why each page was chosen

▸ coverage_check pass=1   musts=7 covered=5 gaps=[r5,r6]
▸ gap_fill r5             accepted=true
▸ coverage_check pass=2   musts=7 covered=7 gaps=[]
  ← the second pass genuinely closing a gap

▸ generate_questions
  ▸ category:technical     requirements_in=6 questions_out=3
  ▸ category:behavioural   requirements_in=1 questions_out=1
  ← four separate calls, and what each one was given
```

---

## What goes in `.env`

Copy `.env.example` to `.env`. It is read automatically by the dev runner, the batch command and
the API.

**For a real run, exactly one variable is required:**

```bash
GEMINI_API_KEY=...     # https://aistudio.google.com/apikey — free tier, no card
```

Everything else has a working default:

| Variable | Needed when | Default |
|---|---|---|
| `TAVILY_API_KEY` | never — absence is a designed-for path | unset → the discussion step records `skipped: no_key` |
| `MONGODB_URI` | running the API with persistence | unset → in-memory, and the API says so on startup |
| `CLERK_ISSUER` | running the API with real auth | unset → dev auth (refused under `NODE_ENV=production`) |
| `ALLOW_PRIVATE_HOSTS` | never set it by hand | `false`; `npm run evaluate` turns it on for itself |
| `GEMINI_MODEL_QUALITY` / `_FAST` | changing models | `gemini-2.5-flash` / `gemini-2.5-flash-lite` |
| `GEMINI_RPM` / `GEMINI_TPM` | a paid tier | `10` / `250000` |

A real one-case run once the key is in place:

```bash
npm run dev:kit -- --jd fixtures/jds/senior-backend.txt --url https://gitlab.com --days 5 \
  --trace-pretty --no-cache --out tmp/real-kit.json
```

`--no-cache` matters for the first real run: it proves a cold path works rather than replaying
something a previous run cached.
