import express from "express";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { searchSubreddits, fetchSubredditPosts, fetchThread } from "./scraper.js";
import { load, save, addLog } from "./store.js";

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

function scoreThread(t, keywords) {
  const text = t.title.toLowerCase();
  const matched = keywords.filter((k) => text.includes(k.toLowerCase()));
  if (matched.length === 0) return null;

  // Opportunity score: prefer fresh threads with some traction but not
  // already-crowded ones (late comments on 500-comment threads get buried).
  const age = t.ageHours ?? 48;
  const freshness = Math.max(0, 60 - age) / 60; // 0..1, linear decay over 60h
  const traction = Math.min(t.score, 200) / 200; // 0..1, capped
  const crowd = t.numComments <= 30 ? 1 : Math.max(0.2, 30 / t.numComments);
  const score =
    matched.length * 10 + freshness * 50 + traction * 25 + crowd * 15;
  return { ...t, matchedKeywords: matched, opportunity: Math.round(score) };
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
  const out = await runClaude(prompt);
  return /^yes/i.test(out.trim());
}

app.post("/api/refresh", async (_req, res) => {
  const d = load();
  if (d.watch.length === 0) return res.json({ results: [], errors: [] });
  if (!d.keywords || d.keywords.length === 0) {
    return res.status(400).json({ error: "no keywords set — add some in the Feed tab first" });
  }
  // A full scan can take many minutes. Never hold one loaded copy of the data
  // file for that whole span and save() it at the end — that would silently
  // clobber any watchlist/keyword edits made while the scan was running with
  // a stale snapshot from when it started. Every write below re-reads fresh
  // via the log() helper (load -> mutate -> save) instead.
  const watch = d.watch;
  const keywords = d.keywords;
  const candidates = [];
  const errors = [];
  log("refresh", `Refresh started — scanning ${watch.length} watched subreddit(s) for ${keywords.length} keyword(s)`);
  for (const w of watch) {
    try {
      const posts = await fetchSubredditPosts(w.name);
      const before = candidates.length;
      for (const p of posts) {
        const scored = scoreThread(p, keywords);
        if (scored && looksLikeQuestion(scored.title)) candidates.push({ ...scored, sub: w.name });
      }
      log("scrape", `Scanned r/${w.name}: ${posts.length} threads fetched, ${candidates.length - before} passed keyword+question filter`);
    } catch (e) {
      errors.push({ sub: w.name, error: e.message });
      log("error", `Scan of r/${w.name} failed: ${e.message}`);
    }
  }

  // Run the AI classifier on survivors. If the local Claude CLI isn't logged
  // in, fail open for the rest of this refresh (heuristic filter only) rather
  // than silently returning an empty feed.
  let results = candidates;
  let classifierAvailable = true;
  if (candidates.length > 0) {
    const classified = [];
    for (const c of candidates) {
      if (!classifierAvailable) { classified.push(c); continue; }
      try {
        if (await classifyEducational(c.title)) classified.push(c);
      } catch (e) {
        classifierAvailable = false;
        log("error", `AI question-classifier unavailable (${e.message.slice(0, 120)}) — using heuristic filter only for the rest of this refresh`);
        classified.push(c);
      }
    }
    results = classified;
  }

  // Reverse-chronological feed, newest first — opportunity score is shown but no
  // longer used to reorder, so this reads like a real feed instead of a ranking.
  results.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
  const lastRefresh = Date.now();
  const fresh = load();
  fresh.lastRefresh = lastRefresh;
  // Persisted so the Feed tab shows the last scan immediately on load/reopen,
  // instead of a blank "hit refresh" screen every time (a full scan can take
  // a few minutes across a large watchlist).
  fresh.lastFeed = { results, errors, lastRefresh, classifierAvailable };
  addLog(
    fresh,
    "refresh",
    `Refresh finished — ${results.length} educational-question thread(s) (of ${candidates.length} keyword matches), ${errors.length} error(s)`
  );
  save(fresh);
  res.json({ results, errors, lastRefresh, classifierAvailable });
});

// Cached feed from the most recent refresh — no rescanning, loads instantly.
app.get("/api/thread-feed", (_req, res) => {
  const { lastFeed } = load();
  res.json(lastFeed || { results: [], errors: [], lastRefresh: null, classifierAvailable: null });
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
// subscription) — no API key involved.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLI_ENV = { ...process.env, PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` };

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", prompt, "--output-format", "text"], {
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

app.post("/api/draft", async (req, res) => {
  const { title, selftext, sub, topComments } = req.body || {};
  const settings = load().settings || {};
  const prompt =
    `Act as an AI mentor — an expert in generative AI, AI/ML, and AI agents — drafting a Reddit reply from the Outskill brand handle.\n\n` +
    `Thread in r/${sub}:\nTitle: ${title}\nBody:\n${(selftext || "(no body)").slice(0, 4000)}\n\n` +
    `Existing top comments (do not repeat their points):\n` +
    (topComments || []).slice(0, 5).map((c) => `- ${c.slice(0, 300)}`).join("\n") +
    `\n\nWhat Outskill teaches (for the plug):\n${settings.outskillContext || "(none)"}\n\n` +
    `Rules:\n` +
    `- Give a specific, actionable answer to the actual question — concrete steps or recommendations, not generalities.\n` +
    `- Keep it short: 60-110 words, conversational Reddit tone, plain text only.\n` +
    `- At the end, naturally mention the ONE most relevant Outskill program, casually — like "this is also something we teach in our <program> at Outskill". It must feel like a normal aside from a practitioner, not an ad.\n` +
    `- NO links of any kind. NO "sign up", "check out", "join us", or any call to action. NO "As an AI".\n` +
    `- Output only the reply text, nothing else.`;
  try {
    const draft = await runClaude(prompt);
    log("draft", `Drafted answer for "${(title || "").slice(0, 60)}" via local Claude CLI`);
    res.json({ draft, manual: false });
  } catch (e) {
    log("error", `Draft failed for "${(title || "").slice(0, 60)}": ${e.message.slice(0, 200)}`);
    res.json({
      draft: null,
      manual: true,
      note: `Local Claude CLI unavailable (${e.message.slice(0, 120)}) — write your reply manually below.`,
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

app.listen(PORT, () => console.log(`Reddit Radar running at http://localhost:${PORT}`));
