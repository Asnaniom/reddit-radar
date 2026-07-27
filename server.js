import express from "express";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { searchSubreddits, fetchSubredditPosts, fetchThread } from "./scraper.js";
import { draftViaChatGPT } from "./chatgpt-browser.js";
import { load, save, addLog, markThreadHandled } from "./store.js";

function log(type, message) {
  const d = load();
  addLog(d, type, message);
  save(d);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4321;

// --- Discover ---------------------------------------------------------------

app.get("/api/search-subreddits", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing q" });
  try {
    const results = await searchSubreddits(q);
    log("search", `Searched subreddits for "${q}" — ${results.length} results`);
    const watching = new Set(load().watch.map((w) => w.name.toLowerCase()));
    res.json(
      results.map((r) => ({ ...r, watching: watching.has(r.name.toLowerCase()) }))
    );
  } catch (e) {
    log("error", `Subreddit search for "${q}" failed: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// --- Watchlist ---------------------------------------------------------------

app.get("/api/watch", (_req, res) => {
  const d = load();
  res.json({ watch: d.watch, lastRefresh: d.lastRefresh });
});

app.post("/api/watch", (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "missing name" });
  const d = load();
  if (!d.watch.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
    d.watch.push({ name, addedAt: Date.now() });
    addLog(d, "watch", `Started watching r/${name}`);
    save(d);
  }
  res.json({ ok: true, watch: d.watch });
});

app.delete("/api/watch/:name", (req, res) => {
  const d = load();
  d.watch = d.watch.filter((w) => w.name.toLowerCase() !== req.params.name.toLowerCase());
  addLog(d, "watch", `Stopped watching r/${req.params.name}`);
  save(d);
  res.json({ ok: true, watch: d.watch });
});

// --- Keywords: one global list applied across every watched subreddit -------

app.get("/api/keywords", (_req, res) => res.json({ keywords: load().keywords || [] }));

app.put("/api/keywords", (req, res) => {
  const d = load();
  const keywords = Array.isArray(req.body?.keywords)
    ? req.body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  d.keywords = [...new Set(keywords)];
  addLog(d, "watch", `Updated global keywords: ${d.keywords.join(", ") || "(none)"}`);
  save(d);
  res.json({ ok: true, keywords: d.keywords });
});

// --- Refresh: scan watched subs, score matching threads ----------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VELOCITY_THRESHOLD = 5; // combined upvotes+comments per hour

function scoreThread(t, keywords) {
  // Word-boundary match, not substring — plain .includes() let "AI" match
  // inside "painting", "captain", "maintain", etc., letting unrelated threads
  // through.
  const matched = keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}\\b`, "i").test(t.title));
  if (matched.length === 0) return null;

  // Opportunity score: prefer fresh threads with some traction but not
  // already-crowded ones (late comments on 500-comment threads get buried).
  const age = t.ageHours ?? 48;
  const freshness = Math.max(0, 60 - age) / 60; // 0..1, linear decay over 60h
  const traction = Math.min(t.score, 200) / 200; // 0..1, capped
  const crowd = t.numComments <= 30 ? 1 : Math.max(0.2, 30 / t.numComments);
  const score =
    matched.length * 10 + freshness * 50 + traction * 25 + crowd * 15;

  // Single-snapshot velocity: traction per hour since posting. There's no
  // history to measure a true rate of change against, so this is a proxy —
  // combined upvotes+comments divided by age, floored at 1h so brand-new
  // threads with a couple of early votes don't spike to absurd values.
  const velocity = (t.score + t.numComments) / Math.max(age, 1);
  const highVelocity = velocity >= VELOCITY_THRESHOLD;

  return {
    ...t,
    matchedKeywords: matched,
    opportunity: Math.round(score),
    velocity: Math.round(velocity * 10) / 10,
    highVelocity,
  };
}

// Stage 1: cheap title heuristic — must read like a genuine question/help
// request, and must not read like news, an announcement, an opinion/rant, or
// a showcase. Cuts obvious non-fits before spending an LLM call on them.
const QUESTION_RE =
  /\?|^\s*(how|what|why|when|where|which|can|could|should|is|are|does|do|will|any(one)?|help|advice|recommend|suggestions?|beginner|new to|trying to|struggling|best way|looking for|need)\b/i;
const NEWS_OPINION_RE =
  /\b(ceo|cto|announces?|launch(ed|es|ing)?|raises?\s*\$|acquir(es|ed|ing)|banned?|lawsuit|regulat(ion|ors?)|unpopular opinion|\brant\b|megathread|breaking|reports?:|update:|news:)\b/i;

function looksLikeQuestion(title) {
  return QUESTION_RE.test(title) && !NEWS_OPINION_RE.test(title);
}

// Stage 2: local Claude CLI classifies survivors as a genuine learning/help
// question vs. news, opinion, rant, or self-promotion — catches things the
// regex can't, e.g. "You used AI? That's not real programming" (has a "?"
// but is a rant, not a question).
async function classifyEducational(title) {
  const prompt =
    `You filter Reddit thread titles for a mentor bot that only replies to threads where someone ` +
    `is genuinely asking for help, guidance, or is curious and trying to learn something in AI, tech, or business.\n\n` +
    `Title: "${title}"\n\n` +
    `Answer with exactly one word: YES if this is a genuine question or request for help/guidance/learning. ` +
    `NO if this is news, an announcement, an opinion piece, a rant, a showcase/self-promotion, or a debate topic rather than someone asking to learn.\n\n` +
    `Answer:`;
  const out = await runClaudeQueued(prompt); // low priority — yields to any in-flight draft request
  return /^yes/i.test(out.trim());
}

// Merges freshly-scored threads from one subreddit into the persisted feed
// immediately, so the Feed tab can show results progressively during a scan
// instead of waiting for all 337 subs to finish. A thread only ever leaves
// the feed when explicitly Replied/Dismissed (handledThreads) — never just
// because it aged out of a subreddit's "new" listing between scans.
function mergeIntoFeed(subResults, errors, classifierAvailable) {
  const fresh = load();
  const handledNow = new Set(fresh.handledThreads);
  const existing = (fresh.lastFeed?.results || []).filter((t) => !handledNow.has(t.permalink));
  const seen = new Set(existing.map((t) => t.permalink));
  const merged = [...existing, ...subResults.filter((t) => !seen.has(t.permalink))];
  merged.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
  fresh.lastFeed = { results: merged, errors, lastRefresh: fresh.lastRefresh, classifierAvailable };
  save(fresh);
  return fresh;
}

// True while a scan is running, so a second "Hit Refresh" click (or a stray
// double-submit) attaches to the existing scan instead of starting a
// duplicate one racing over the same data file.
let scanInProgress = false;

async function runScan(watch, keywords) {
  const startedAt = Date.now();
  const total = watch.length;
  const errors = [];
  let classifierAvailable = true;

  const init = load();
  init.scanStatus = { inProgress: true, startedAt, total, scanned: 0 };
  save(init);
  log("refresh", `Refresh started — scanning ${total} watched subreddit(s) for ${keywords.length} keyword(s)`);

  for (const w of watch) {
    const subResults = [];
    try {
      const posts = await fetchSubredditPosts(w.name);
      const handledNow = new Set(load().handledThreads);
      const candidates = [];
      for (const p of posts) {
        if (handledNow.has(p.permalink)) continue; // already replied to or dismissed
        const scored = scoreThread(p, keywords);
        if (scored && looksLikeQuestion(scored.title)) candidates.push({ ...scored, sub: w.name });
      }
      // Run the AI classifier on survivors. If the local Claude CLI isn't
      // logged in, fail open for the rest of the scan (heuristic filter
      // only) rather than silently returning an empty feed.
      for (const c of candidates) {
        if (!classifierAvailable) { subResults.push(c); continue; }
        try {
          if (await classifyEducational(c.title)) subResults.push(c);
        } catch (e) {
          classifierAvailable = false;
          log("error", `AI question-classifier unavailable (${e.message.slice(0, 120)}) — using heuristic filter only for the rest of this refresh`);
          subResults.push(c);
        }
      }
      log("scrape", `Scanned r/${w.name}: ${posts.length} threads fetched, ${subResults.length} passed keyword+question filter`);
    } catch (e) {
      errors.push({ sub: w.name, error: e.message });
      log("error", `Scan of r/${w.name} failed: ${e.message}`);
    }

    const fresh = subResults.length > 0 ? mergeIntoFeed(subResults, errors, classifierAvailable) : load();
    fresh.scanStatus = { inProgress: true, startedAt, total, scanned: fresh.scanStatus.scanned + 1 };
    if (fresh.lastFeed) fresh.lastFeed.errors = errors;
    save(fresh);
  }

  const lastRefresh = Date.now();
  const fresh = load();
  fresh.lastRefresh = lastRefresh;
  if (fresh.lastFeed) {
    fresh.lastFeed.lastRefresh = lastRefresh;
    fresh.lastFeed.errors = errors;
    fresh.lastFeed.classifierAvailable = classifierAvailable;
  }
  fresh.scanStatus = { inProgress: false, startedAt, total, scanned: total, finishedAt: lastRefresh };
  addLog(
    fresh,
    "refresh",
    `Refresh finished — ${fresh.lastFeed?.results.length ?? 0} total in feed, ${errors.length} error(s)`
  );
  save(fresh);
}

app.post("/api/refresh", async (_req, res) => {
  const d = load();
  if (d.watch.length === 0) return res.json({ started: false, results: [], errors: [] });
  if (!d.keywords || d.keywords.length === 0) {
    return res.status(400).json({ error: "no keywords set — add some in the Feed tab first" });
  }
  if (scanInProgress) return res.json({ started: false, alreadyRunning: true });

  scanInProgress = true;
  runScan(d.watch, d.keywords)
    .catch((e) => log("error", `Refresh crashed: ${e.message}`))
    .finally(() => { scanInProgress = false; });
  res.json({ started: true });
});

// Cached feed from the most recent (or in-progress) refresh — no rescanning,
// loads instantly. Polled by the frontend while a scan is running so results
// appear progressively instead of only once the whole scan finishes.
app.get("/api/thread-feed", (_req, res) => {
  const { lastFeed, scanStatus } = load();
  res.json({ ...(lastFeed || { results: [], errors: [], lastRefresh: null, classifierAvailable: null }), scanStatus });
});

// Dismiss a thread — drops it from the feed permanently, no reply drafted.
app.post("/api/feed/dismiss", (req, res) => {
  const { permalink, title } = req.body || {};
  if (!permalink) return res.status(400).json({ error: "missing permalink" });
  const d = load();
  markThreadHandled(d, permalink);
  addLog(d, "watch", `Dismissed thread: "${(title || permalink).slice(0, 60)}"`);
  save(d);
  res.json({ ok: true });
});

// --- Thread detail + answer drafting -----------------------------------------

app.get("/api/thread", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https:\/\/(old|www)\.reddit\.com\//.test(url)) {
    return res.status(400).json({ error: "invalid thread url" });
  }
  try {
    const t = await fetchThread(url);
    log("scrape", `Opened thread "${(t.title || url).slice(0, 80)}" — ${t.numComments} comments scraped`);
    res.json(t);
  } catch (e) {
    log("error", `Thread scrape failed for ${url}: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// Drafting runs through the local `claude` CLI (the user's existing Claude Code
// subscription) — no API key involved. Explicitly pinned to Sonnet: measured
// head-to-head on this system (3 runs each, same prompt), Sonnet averaged
// ~11s vs Haiku's ~17s — the opposite of what model size would suggest, but
// trust the measurement over the assumption.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const CLI_ENV = { ...process.env, PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` };

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", prompt, "--model", CLAUDE_MODEL, "--output-format", "text"], {
      env: CLI_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", errOut = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(errOut.trim() || `claude exited with code ${code}`));
    });
  });
}

// The background scan's question-classifier and an interactive "Reply"
// click both ultimately spawn the same local `claude` CLI. Left unbounded,
// a scan in progress runs its classifier concurrently with a draft request,
// and the two processes fight over CPU/network on one machine — this is
// what pushed drafting from its earlier ~11s benchmark past a minute.
// Serialize all CLI calls through one queue, with draft requests always
// jumping ahead of queued classifier calls, so replying stays fast
// regardless of what the background scan is doing.
let cliBusy = false;
const cliQueue = [];

function pumpCliQueue() {
  if (cliBusy || cliQueue.length === 0) return;
  cliBusy = true;
  const { prompt, resolve, reject } = cliQueue.shift();
  runClaude(prompt)
    .then(resolve, reject)
    .finally(() => { cliBusy = false; pumpCliQueue(); });
}

function runClaudeQueued(prompt, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const task = { prompt, resolve, reject };
    if (priority) cliQueue.unshift(task);
    else cliQueue.push(task);
    pumpCliQueue();
  });
}

// LLMs often ignore "no em dashes" as a pure instruction — enforce it as a
// safety net too. A plain hyphen-with-spaces reads more like natural typing.
function stripEmDashes(text) {
  return text.replace(/\s*[—–]\s*/g, " - ");
}

app.post("/api/draft", async (req, res) => {
  const { title, selftext, sub, topComments } = req.body || {};
  const prompt =
    `Act as an AI mentor — a practitioner in generative AI, AI/ML, and AI agents — replying to a Reddit thread.\n\n` +
    `Thread in r/${sub}:\nTitle: ${title}\nBody:\n${(selftext || "(no body)").slice(0, 4000)}\n\n` +
    `Existing top comments (do not repeat their points):\n` +
    (topComments || []).slice(0, 5).map((c) => `- ${c.slice(0, 300)}`).join("\n") +
    `\n\nRules:\n` +
    `- Give an accurate, specific, actionable answer to the actual question. Not verbose — no fluff, no generalities, no filler.\n` +
    `- Reply in the SAME language/style the thread itself is written in (e.g. Hindi, Hinglish, or any other language) — match the asker.\n` +
    `- Write like a real person casually replying on Reddit — conversational, natural, contractions are fine. NOT a formal or corporate tone.\n` +
    `- Format for readability: short paragraphs separated by a blank line, and a plain "-" bullet list if you're listing multiple things. Don't write one dense wall of text.\n` +
    `- Do NOT use em dashes (—) or en dashes (–) anywhere. Use a period, comma, or "and" instead.\n` +
    `- Do NOT mention Outskill, any course, program, or anything promotional. Just answer the question.\n` +
    `- Keep it short: roughly 50-100 words total.\n` +
    `- End with exactly this sign-off on its own line: "Thanks, Om from Outskill"\n` +
    `- Output only the reply text, nothing else.`;
  // DRAFT_PROVIDER=chatgpt drives a logged-in Chrome profile against
  // chatgpt.com (npm run chatgpt-login sets it up); default uses the local
  // `claude` CLI. Both use an existing subscription, no API key.
  const provider = (process.env.DRAFT_PROVIDER || "claude").toLowerCase();
  try {
    const raw = provider === "chatgpt" ? await draftViaChatGPT(prompt) : await runClaudeQueued(prompt, { priority: true });
    const draft = stripEmDashes(raw);
    log("draft", `Drafted answer for "${(title || "").slice(0, 60)}" via ${provider === "chatgpt" ? "ChatGPT (browser)" : "local Claude CLI"}`);
    res.json({ draft, manual: false });
  } catch (e) {
    log("error", `Draft failed for "${(title || "").slice(0, 60)}": ${e.message.slice(0, 200)}`);
    res.json({
      draft: null,
      manual: true,
      note:
        provider === "chatgpt"
          ? `ChatGPT automation unavailable (${e.message.slice(0, 120)}) — write your reply manually below.`
          : `Local Claude CLI unavailable (${e.message.slice(0, 120)}) — write your reply manually below.`,
    });
  }
});

// --- Posted tracker: human posts manually, tool re-checks --------------------

app.get("/api/posted", (_req, res) => res.json(load().posted));

app.post("/api/posted", (req, res) => {
  const { threadUrl, title, sub, comment } = req.body || {};
  if (!threadUrl || !comment) return res.status(400).json({ error: "missing threadUrl or comment" });
  const d = load();
  d.posted.unshift({
    threadUrl,
    title: title || "",
    sub: sub || "",
    comment,
    postedAt: Date.now(),
    status: "pending",
    lastCheckedAt: null,
  });
  markThreadHandled(d, threadUrl);
  addLog(d, "posted", `Tracking posted answer on r/${sub}: "${(title || threadUrl).slice(0, 60)}"`);
  save(d);
  res.json({ ok: true });
});

app.delete("/api/posted", (req, res) => {
  const d = load();
  d.posted = d.posted.filter((p) => p.threadUrl !== req.body?.threadUrl);
  addLog(d, "posted", `Stopped tracking ${req.body?.threadUrl || "(unknown thread)"}`);
  save(d);
  res.json({ ok: true });
});

// Re-scrape tracked threads and check whether the saved comment text appears.
app.post("/api/check-posted", async (_req, res) => {
  // Same stale-snapshot hazard as refresh, just a smaller window: don't hold
  // one loaded copy across the whole scan and save() it at the end. Collect
  // per-item results, then merge into a freshly-loaded copy at the end.
  const posted = load().posted;
  const errors = [];
  const updates = new Map(); // threadUrl -> { status, lastCheckedAt }
  for (const p of posted) {
    try {
      const thread = await fetchThread(p.threadUrl);
      const needle = p.comment.slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
      const found = thread.comments.some((c) =>
        c.body.toLowerCase().replace(/\s+/g, " ").includes(needle)
      );
      updates.set(p.threadUrl, { status: found ? "found" : "not-found", lastCheckedAt: Date.now() });
      log("check", `Re-checked "${(p.title || p.threadUrl).slice(0, 60)}" — answer ${found ? "is live" : "not found yet"}`);
    } catch (e) {
      errors.push({ threadUrl: p.threadUrl, error: e.message });
      log("error", `Re-check failed for ${p.threadUrl}: ${e.message}`);
    }
  }
  const fresh = load();
  for (const p of fresh.posted) {
    const u = updates.get(p.threadUrl);
    if (u) Object.assign(p, u);
  }
  save(fresh);
  res.json({ posted: fresh.posted, errors });
});

// --- Activity log ------------------------------------------------------------

app.get("/api/logs", (_req, res) => res.json(load().logs));

app.delete("/api/logs", (_req, res) => {
  const d = load();
  d.logs = [];
  save(d);
  res.json({ ok: true });
});

// A scan left mid-flight when the process last exited (crash, restart) can
// never actually finish — nothing will clear scanStatus.inProgress on its
// own, which would otherwise leave the UI showing "scanning…" forever.
(function resetStaleScanStatus() {
  const d = load();
  if (d.scanStatus?.inProgress) {
    d.scanStatus = { ...d.scanStatus, inProgress: false };
    save(d);
  }
})();

app.listen(PORT, () => console.log(`Reddit Radar running at http://localhost:${PORT}`));
