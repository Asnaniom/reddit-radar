// Tiny JSON-file persistence for the watchlist and posted-comment tracker.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "data.json");

const DEFAULTS = {
  // watch: [{ name, addedAt }]
  watch: [],
  // keywords: [..] — one global list, applied across every watched subreddit
  keywords: [],
  // posted: [{ threadUrl, title, sub, comment, postedAt, status: "pending"|"found"|"not-found", lastCheckedAt }]
  posted: [],
  // logs: [{ at, type, message }]
  logs: [],
  lastRefresh: null,
  // lastFeed: cached result of the most recent /api/refresh scan, so the Feed
  // tab has something to show immediately without rescanning on every visit.
  lastFeed: null,
  settings: {
    // What Outskill teaches — baked into every drafted answer.
    outskillContext:
      "Outskill (outskill.com) runs live AI education programs:\n" +
      "- 3-Day Generative AI Bootcamp: for working professionals, entrepreneurs, consultants and freelancers; no coding needed; prompt engineering, ChatGPT/OpenAI workflows, hands-on workbooks after every session.\n" +
      "- AI Generalist Bootcamp & 6-Month AI Generalist Fellowship: build a deployed web app, an autonomous n8n agent running a real process, an AI assistant grounded in your own documents, an HD ad film, and a reusable prompt library.\n" +
      "- AI Engineering Accelerator & 6-Month AI Engineering Fellowship (also a 2-Day AI Engineering Mastermind): for engineers with basic Python; build production-ready RAG systems and agentic AI; mentor support for 30 days after.\n" +
      "- AI for Engineers workshop: production-focused, engineers typically deploy their first AI system within a week.",
  },
};

const MAX_LOGS = 500;

export function addLog(data, type, message) {
  data.logs.unshift({ at: Date.now(), type, message });
  if (data.logs.length > MAX_LOGS) data.logs.length = MAX_LOGS;
}

export function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
