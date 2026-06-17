/**
 * Job Tracker — Cloudflare Worker
 * Serves static assets (index.html) + REST API backed by KV
 *
 * GET  /api/jobs          → list all jobs (public)
 * PATCH /api/jobs         → update stage  { company, role, stage }
 * POST /api/jobs          → add a job     { company, role, fit, stage, salary, url, note }
 * POST /api/jobs/seed     → load /data/seed.json into KV (one-time setup)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function checkKey(request, env) {
  if (!env.API_KEY) return true;
  return request.headers.get("X-Api-Key") === env.API_KEY;
}

async function getJobs(env) {
  const raw = await env.JOB_TRACKER.get("jobs");
  return raw ? JSON.parse(raw) : [];
}

async function saveJobs(env, jobs) {
  await env.JOB_TRACKER.put("jobs", JSON.stringify(jobs));
}

async function handleAPI(request, env, url) {
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // GET — public read
  if (method === "GET") {
    const jobs = await getJobs(env);
    return json(jobs);
  }

  // All writes require API key (optional — skipped if API_KEY not set)
  if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));

  // PATCH — update stage
  if (method === "PATCH") {
    const { company, role, stage } = body;
    if (!company || !role || !stage)
      return json({ error: "company, role, stage required" }, 400);
    const jobs = await getJobs(env);
    const job = jobs.find(
      (j) =>
        j.company.toLowerCase() === company.toLowerCase() &&
        j.role.toLowerCase() === role.toLowerCase()
    );
    if (!job) return json({ error: "job not found" }, 404);
    job.stage = stage;
    await saveJobs(env, jobs);
    return json({ ok: true, job });
  }

  // POST /api/jobs/seed — one-time seed from public/data/seed.json
  if (method === "POST" && url.pathname.endsWith("/seed")) {
    const seedUrl = new URL("/data/seed.json", url.origin);
    const seedRes = await env.ASSETS.fetch(seedUrl.toString());
    if (!seedRes.ok) return json({ error: "seed.json not found" }, 500);
    const seed = await seedRes.json();
    await saveJobs(env, seed);
    return json({ ok: true, count: seed.length });
  }

  // POST — add a new job
  if (method === "POST") {
    const { company, role, fit, stage, salary, url: jobUrl, note } = body;
    if (!company || !role) return json({ error: "company and role required" }, 400);
    const jobs = await getJobs(env);
    const exists = jobs.some(
      (j) =>
        j.company.toLowerCase() === company.toLowerCase() &&
        j.role.toLowerCase() === role.toLowerCase()
    );
    if (exists) return json({ error: "duplicate" }, 409);
    const newJob = {
      company, role,
      fit: fit || 0,
      stage: stage || "NEW",
      salary: salary || "уточнить",
      url: jobUrl || "",
      note: note || "",
    };
    jobs.unshift(newJob);
    await saveJobs(env, jobs);
    return json({ ok: true, job: newJob }, 201);
  }

  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route API calls
    if (url.pathname.startsWith("/api/jobs")) {
      return handleAPI(request, env, url);
    }

    // Everything else → static assets (index.html, data/seed.json, etc.)
    return env.ASSETS.fetch(request);
  },
};
