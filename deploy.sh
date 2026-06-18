#!/bin/bash
# Deploy job-search-tracker worker to Cloudflare
# Usage: bash deploy.sh

ACCOUNT_ID="35b747930266ac34273872da0d4e24ec"
SCRIPT_NAME="job-search-tracker"
# Set CF_API_TOKEN in your environment or .env file (never commit the token)
API_TOKEN="${CF_API_TOKEN:?CF_API_TOKEN is not set. Export it before running this script.}"
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$WORKER_DIR/worker_deploy.js"

echo "=== Step 1: Bundle worker with inline HTML + seed ==="

python3 - "$WORKER_DIR" << 'PYEOF'
import json, sys

d = sys.argv[1]

with open(d + '/worker.js') as f:
    worker = f.read()

with open(d + '/public/index.html') as f:
    html = f.read()

with open(d + '/public/data/seed.json') as f:
    seed = f.read()

worker = worker.replace('null; // INJECTED_HTML', json.dumps(html) + ';', 1)
worker = worker.replace('null; // INJECTED_SEED', json.dumps(seed) + ';', 1)

out = d + '/worker_deploy.js'
with open(out, 'w') as f:
    f.write(worker)

size = len(worker.encode('utf-8'))
print(f"Bundled OK — {size:,} bytes ({size/1024:.1f} KB)")
PYEOF

if [ $? -ne 0 ]; then
  echo "❌ Bundling failed"
  exit 1
fi

echo ""
echo "=== Step 2: Deploy to Cloudflare ==="

metadata='{"main_module":"worker_deploy.js","compatibility_date":"2024-09-23","bindings":[{"type":"inherit","name":"BOT_TOKEN"},{"type":"inherit","name":"CHAT_ID"},{"type":"kv_namespace","name":"JOB_TRACKER","namespace_id":"6442ad1dcedc431080ef16a37da190d7"}]}'

deploy_resp=$(curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "metadata=$metadata;type=application/json" \
  -F "worker_deploy.js=@$BUNDLE;type=application/javascript+module")

success=$(echo "$deploy_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success'))" 2>/dev/null)

if [ "$success" = "True" ]; then
  echo "✅ Deployed successfully!"
  rm -f "$BUNDLE"
else
  echo "❌ Deploy failed:"
  echo "$deploy_resp" | python3 -m json.tool 2>/dev/null || echo "$deploy_resp"
  rm -f "$BUNDLE"
  exit 1
fi
