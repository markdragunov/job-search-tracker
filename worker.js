/**
 * Job Tracker — Cloudflare Worker
 * Serves static assets (index.html) + REST API backed by KV
 *
 * GET  /api/jobs          → list all jobs
 * PATCH /api/jobs         → update any field { company, role, ...fields }
 * POST /api/jobs          → add one job
 * POST /api/jobs/batch    → add multiple jobs, one Telegram digest
 * POST /api/jobs/seed     → load /data/seed.json into KV
 *
 * Env vars:
 *   JOB_TRACKER  — KV namespace binding
 *   API_KEY      — optional write auth
 *   BOT_TOKEN    — Telegram bot token
 *   CHAT_ID      — Telegram chat_id
 *   DASHBOARD_URL — override dashboard link (default: auto from request origin)
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

const PRIO_EMOJI = {
  3: "❤️‍🔥❤️‍🔥❤️‍🔥",
  2: "🔥🔥🔥",
  1: "❤️❤️❤️",
  0: "👆🏻👆🏻👆🏻",
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

function dashboardUrl(env, requestUrl) {
  return env.DASHBOARD_URL || new URL(requestUrl).origin;
}

/* ── TELEGRAM: single job ── */
async function sendTelegram(env, job, reqUrl) {
  try {
    const fitIcon = job.fit >= 9 ? "🔥" : job.fit >= 8 ? "⭐" : "📌";
    const prioLine = job.prio != null && PRIO_EMOJI[job.prio]
      ? `Priority: ${PRIO_EMOJI[job.prio]}\n`
      : "";
    const applyLine = job.url ? `\n🔗 <a href="${job.url}">Link to apply</a>` : "";
    const dashboard = dashboardUrl(env, reqUrl);

    const text =
      `${fitIcon} Новая вакансия добавлена\n\n` +
      `<b>${job.company} — ${job.role}</b>\n` +
      prioLine +
      `Fit: ${job.fit}\n` +
      `Salary: ${job.salary}` +
      applyLine +
      `\n\n<a href="${dashboard}">📊 Открыть дашборд</a>`;

    await tgSend(env, text);
  } catch (_) {}
}

/* ── TELEGRAM: batch digest ── */
async function sendTelegramBatch(env, added, reqUrl) {
  try {
    if (!added.length) return;
    const dashboard = dashboardUrl(env, reqUrl);
    const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

    const header = added.length === 1
      ? `🔥 Job Scout нашёл новую вакансию`
      : `🔥 Job Scout нашёл ${added.length} новых вакансии`;

    const lines = added.map((job, i) => {
      const num = nums[i] || `${i+1}.`;
      const prioLine = job.prio != null && PRIO_EMOJI[job.prio]
        ? ` ${PRIO_EMOJI[job.prio]}` : "";
      const applyPart = job.url ? ` · <a href="${job.url}">Apply →</a>` : "";
      return `${num} <b>${job.company} — ${job.role}</b>\n` +
             `   Fit: ${job.fit}${prioLine} · ${job.salary}${applyPart}`;
    }).join("\n\n");

    const text = `${header}\n\n${lines}\n\n<a href="${dashboard}">📊 Открыть дашборд</a>`;
    await tgSend(env, text);
  } catch (_) {}
}

async function tgSend(env, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

function buildJob(fields, now) {
  const { company, role, fit, stage, salary, url: jobUrl, note, date_update, prio } = fields;
  return {
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
      if (updates[key] !== undefined) job[key] = updates[key];
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

  // POST /api/jobs/batch — add multiple jobs, one Telegram digest
  if (method === "POST" && url.pathname.endsWith("/batch")) {
    const incoming = Array.isArray(body.jobs) ? body.jobs : [];
    if (!incoming.length) return json({ error: "jobs array required" }, 400);

    const jobs = await getJobs(env);
    const now = new Date().toISOString();
    const added = [];
    const skipped = [];

    for (const fields of incoming) {
      if (!fields.company || !fields.role) { skipped.push({ reason: "missing fields", ...fields }); continue; }
      const exists = jobs.some(
        j => j.company.toLowerCase() === fields.company.toLowerCase() &&
             j.role.toLowerCase() === fields.role.toLowerCase()
      );
      if (exists) { skipped.push({ reason: "duplicate", company: fields.company, role: fields.role }); continue; }
      const newJob = buildJob(fields, now);
      jobs.unshift(newJob);
      added.push(newJob);
    }

    if (added.length) {
      await saveJobs(env, jobs);
      if (env.BOT_TOKEN && env.CHAT_ID) {
        ctx.waitUntil(sendTelegramBatch(env, added, request.url));
      }
    }

    return json({ ok: true, added: added.length, skipped: skipped.length, jobs: added }, added.length ? 201 : 200);
  }

  // POST — add a single job
  if (method === "POST") {
    const { company, role } = body;
    if (!company || !role) return json({ error: "company and role required" }, 400);

    const jobs = await getJobs(env);
    const exists = jobs.some(
      j => j.company.toLowerCase() === company.toLowerCase() &&
           j.role.toLowerCase() === role.toLowerCase()
    );
    if (exists) return json({ error: "duplicate" }, 409);

    const now = new Date().toISOString();
    const newJob = buildJob(body, now);
    jobs.unshift(newJob);
    await saveJobs(env, jobs);

    if (env.BOT_TOKEN && env.CHAT_ID) {
      ctx.waitUntil(sendTelegram(env, newJob, request.url));
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
