/**
 * Job Tracker — Cloudflare Worker
 * Serves static assets (index.html) + REST API backed by KV
 *
 * GET  /api/jobs          → list all jobs (public)
 * PATCH /api/jobs         → update any field { company, role, stage?, note?, date_update? }
 * POST /api/jobs          → add a job { company, role, fit, stage, salary, url, note, date_update }
 * POST /api/jobs/seed     → load /data/seed.json into KV (one-time setup)
 *
 * Env vars:
 *   JOB_TRACKER  — KV namespace binding
 *   API_KEY      — optional write auth
 *   BOT_TOKEN    — Telegram bot token (optional)
 *   CHAT_ID      — Telegram chat_id (optional)
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

async function sendTelegram(env, job) {
  try {
    const icon = job.fit >= 9 ? "🔥" : job.fit >= 8 ? "⭐" : "📌";
    const text =
      `${icon} Новая вакансия добавлена\n\n` +
      `${job.company} — ${job.role}\n` +
      `Fit: ${job.fit} | ${job.salary}\n` +
      (job.url ? `\n${job.url}` : "");
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text,
          disable_web_page_preview: false,
        }),
      }
    );
  } catch (_) {
    // Telegram failure must not affect main request
  }
}

async function handleAPI(request, env, ctx, url) {
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (method === "GET") {
    return json(await getJobs(env));
  }

  if (!checkKey(request, env)) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));

  // PATCH — update any field(s)
  if (method === "PATCH") {
    const { company, role, ...updates } = body;
    if (!company || !role)
      return json({ error: "company and role required" }, 400);

    const jobs = await getJobs(env);
    const job = jobs.find(
      (j) =>
        j.company.toLowerCase() === company.toLowerCase() &&
        j.role.toLowerCase() === role.toLowerCase()
    );
    if (!job) return json({ error: "job not found" }, 404);

    const ALLOWED = ["stage", "note", "date_update", "salary", "fit", "url", "prio"];
    for (const key of ALLOWED) {
      if (updates[key] !== undefined) {
        job[key] = updates[key];
      }
    }
    if (updates.stage !== undefined) {
      job.stage_updated_at = new Date().toISOString();
    }

    await saveJobs(env, jobs);
    return json({ ok: true, job });
  }

  // POST /api/jobs/seed
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
    const { company, role, fit, stage, salary, url: jobUrl, note, date_update, prio } = body;
    if (!company || !role) return json({ error: "company and role required" }, 400);

    const jobs = await getJobs(env);
    const exists = jobs.some(
      (j) =>
        j.company.toLowerCase() === company.toLowerCase() &&
        j.role.toLowerCase() === role.toLowerCase()
    );
    if (exists) return json({ error: "duplicate" }, 409);

    const now = new Date().toISOString();
    const newJob = {
      company,
      role,
      fit: fit || 0,
      stage: stage || "NEW",
      salary: salary || "уточнить",
      url: jobUrl || "",
      note: note || "",
      prio: prio ?? null,
      date_added: now,
      stage_updated_at: now,
      date_update: date_update || "",
    };
    jobs.unshift(newJob);
    await saveJobs(env, jobs);

    if (env.BOT_TOKEN && env.CHAT_ID) {
      ctx.waitUntil(sendTelegram(env, newJob));
    }

    return json({ ok: true, job: newJob }, 201);
  }

  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/jobs")) {
      return handleAPI(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },
};
