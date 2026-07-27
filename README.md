# Mailroom Action Gate Agent

Implements `ga5-mailroom-action-gate/v2`: one HTTPS endpoint,
`POST /v1/mailroom/actions`, handling `propose` and `commit`.

This setup uses **no credit card anywhere**:
- **Koyeb** for compute (free instance, no card, ~1 hour idle before scale-to-zero, 1-5s cold start)
- **Turso** for persistence (free SQLite-compatible database, no card, survives restarts/redeploys since it isn't local disk)
- **Google Gemini** for the model (free tier, no card)

## 1. Get a Gemini API key

Go to **aistudio.google.com/apikey**, sign in with a Google account, click **Create API key**. No card involved.

## 2. Get a Turso database

1. Install the Turso CLI:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
   (Windows: use WSL, or see turso.tech/docs for the Windows install path.)
2. Sign up (no card):
   ```bash
   turso auth signup
   ```
3. Create a database:
   ```bash
   turso db create mailroom-agent
   ```
4. Get the connection details:
   ```bash
   turso db show mailroom-agent --url
   turso db tokens create mailroom-agent
   ```
   The first command gives you `TURSO_DATABASE_URL` (starts with `libsql://`), the second gives you `TURSO_AUTH_TOKEN`.

## 3. Local setup and testing

```bash
npm install
cp .env.example .env
# edit .env: set GEMINI_API_KEY, and optionally TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
#   (if you leave these blank, it uses a local file automatically - fine for local testing)
npm test                      # offline tests - no model, no network, no Turso needed
npm start                     # runs the server locally on :8080
```

In another terminal, exercise the full propose+commit round trip against your running server:
```bash
node scripts/manual-test.js http://localhost:8080/v1/mailroom/actions
```

## 4. Deploy on Koyeb

1. Push this project to a GitHub repository (Koyeb deploys from Git, same as most PaaS platforms):
   ```bash
   git init && git add . && git commit -m "mailroom agent"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/YOUR-USERNAME/mailroom-agent.git
   git branch -M main
   git push -u origin main
   ```
2. Go to **koyeb.com**, sign up (no card).
3. **Create Service** → connect your GitHub account → select the repo.
4. Builder: choose **Dockerfile** (Koyeb will detect the one in this repo).
5. Instance type: **Free**.
6. Under **Environment variables**, add:
   ```
   MODEL_PROVIDER=gemini
   GEMINI_API_KEY=<your key>
   GEMINI_MODEL=gemini-3.1-flash-lite
   TURSO_DATABASE_URL=<your libsql:// url>
   TURSO_AUTH_TOKEN=<your token>
   MODEL_CHUNK_SIZE=10
   MODEL_TIMEOUT_MS=20000
   ```
7. Port: **8080** (matches the Dockerfile).
8. Click **Deploy**. Wait for the build to finish and the service to show healthy.
9. Koyeb gives you a URL like `https://your-app-name-your-org.koyeb.app`.

## 5. Verify the deployed endpoint

```bash
curl -X POST https://your-app-name-your-org.koyeb.app/v1/mailroom/actions \
  -H "Content-Type: application/json" \
  -d '{"operation":"propose"}'
# expect: HTTP 400/422 with a JSON error body

node scripts/manual-test.js https://your-app-name-your-org.koyeb.app/v1/mailroom/actions
# expect: real varied decisions across the 5 sample dossiers, then a successful commit
```

## 6. Submit the URL

```
https://your-app-name-your-org.koyeb.app/v1/mailroom/actions
```
No query string, no fragment, no credentials in it.

## Why this combination specifically

Every compute host that skips the credit-card requirement does so by keeping
its instances stateless/ephemeral by design - that's true of Koyeb, and it
would be equally true of Render's or Fly's free tiers if either still had
one without a card. Fighting that by hoping local disk survives is fragile.
Turso solves it directly: persistence lives in a real hosted database
instead of the container's filesystem, so it doesn't matter whether Koyeb
scales your instance to zero, restarts it, or rebuilds it entirely - the
next request just reconnects to the same Turso database and finds
everything exactly as it left it. This is also *more* robust than the
disk-based Render setup from earlier in this project's history, not just
cheaper.

## Project layout

```
src/
  canonical.js   canonical (key-sorted, compact) JSON + SHA-256 digest helpers
  ed25519.js     Ed25519 JWK import + signature verification
  db.js          Turso/libSQL persistence (file: locally, libsql:// in production)
  schema.js      request envelope validation (400/422 before any AI/tool work)
  actions.js     frozen target/payload schemas + code-level safety net
  model.js       pluggable AI decision step (gemini/anthropic/openai/ollama/mock), batched
  propose.js     propose handler: cache lookup, model call, persist, respond
  commit.js      commit handler: receipt/signature verification, persist, respond
  server.js      Express wiring for the single POST endpoint
test/
  local-test.js  offline tests: replay, conflict, malformed input, signature checks
scripts/
  manual-test.js full propose+commit round trip against any running server (local or deployed)
```
