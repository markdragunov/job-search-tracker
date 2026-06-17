# Job Tracker — mark-d.dev

Senior PM job search tracker. Cloudflare Pages + KV, deploys to `mark-d.dev`.

## Files

```
index.html              — frontend (fetches /api/jobs, patches stages live)
functions/
  api/
    jobs.js             — Cloudflare Pages Function (GET / POST / PATCH)
data/
  seed.json             — 59 initial jobs extracted from old tracker
wrangler.toml           — CF Pages config (KV binding)
```

## Deploy (first time)

### 1. Create KV namespace

```bash
npx wrangler kv namespace create JOB_TRACKER
```

Copy the `id` it prints. Paste into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "JOB_TRACKER"
id = "paste-id-here"
```

### 2. Push to GitHub, connect to Cloudflare Pages

- Create a GitHub repo (e.g. `job-tracker`)
- Push this folder
- In Cloudflare dashboard → Pages → Create project → Connect to Git
- Build command: *(leave empty)*
- Output directory: `.`
- Add KV binding in Pages settings: `JOB_TRACKER` → your namespace ID
- Add custom domain `mark-d.dev` (or subdomain)

### 3. Seed the database

After deploy, run once:

```bash
curl -X POST https://mark-d.dev/api/jobs/seed \
  -H "X-Api-Key: YOUR_API_KEY"
```

Or without auth (if `API_KEY` env var not set):

```bash
curl -X POST https://mark-d.dev/api/jobs/seed
```

### 4. (Optional) Set API key for writes

In Cloudflare Pages → Settings → Environment variables:
- `API_KEY` = any random string

Without it, all writes are open — fine for personal use.

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/jobs | No | List all jobs |
| POST | /api/jobs | Yes | Add a job |
| PATCH | /api/jobs | Yes | Update stage |
| POST | /api/jobs/seed | Yes | Load seed.json into KV |

### Add a job (from Job Scout agent)

```bash
curl -X POST https://mark-d.dev/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_KEY" \
  -d '{
    "company": "Stripe",
    "role": "Senior PM, Payments",
    "fit": 9,
    "stage": "NEW",
    "salary": "€100-130k",
    "url": "https://stripe.com/jobs/...",
    "note": "API-first checkout, remote EU"
  }'
```

Returns `409` if company+role already exists (dedup).

### Update stage

```bash
curl -X PATCH https://mark-d.dev/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: YOUR_KEY" \
  -d '{"company": "Stripe", "role": "Senior PM, Payments", "stage": "Applied"}'
```

## Update 11_Job_Scout.md

Change step 4 in the agent spec from "edit index.html" to:

```
4. POST new roles to https://mark-d.dev/api/jobs with fit, stage:"NEW", salary, url, note.
   API returns 409 if duplicate — skip silently. Dedup is handled server-side.
```
