// Scrapes public old.reddit.com HTML — no Reddit API, no account, no auth.
// Polite by design: single-file queue, browser UA, small page counts. A
// 3-lane concurrent version was tried and reverted — it triggered HTTP 429 on
// ~70% of requests in a 337-subreddit scan. Do not raise concurrency/pace.
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MIN_GAP_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;
let lastRequestAt = 0;

// A background scan queues hundreds of listing fetches back to back; an
// interactive request (opening a specific thread before drafting a reply)
// must not sit behind all of them or it looks broken until the scan
// finishes. Array-based queue instead of a plain promise chain so a
// priority request can jump to the front — same pattern as the CLI queue
// in server.js, same reasoning: one shared, rate-limited resource, and
// interactive requests shouldn't wait behind bulk background work.
let queueBusy = false;
const fetchQueue = [];

function pumpQueue() {
  if (queueBusy || fetchQueue.length === 0) return;
  queueBusy = true;
  const { fn, resolve, reject } = fetchQueue.shift();
  const wait = Math.max(0, lastRequestAt + MIN_GAP_MS - Date.now());
  setTimeout(async () => {
    lastRequestAt = Date.now();
    try {
      resolve(await fn());
    } catch (e) {
      reject(e);
    } finally {
      queueBusy = false;
      pumpQueue();
    }
  }, wait);
}

function throttled(fn, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const task = { fn, resolve, reject };
    if (priority) fetchQueue.unshift(task);
    else fetchQueue.push(task);
    pumpQueue();
  });
}

// Does the actual fetch + 429 retry-with-backoff. Deliberately does NOT call
// throttled() again on retry — an earlier version recursed into fetchHtml
// (and so back into throttled/queue) from inside an already-running throttled
// callback, which deadlocks: the queue can't advance until the retry settles,
// but the retry can't start until the queue advances. Retries now stay
// entirely inside the single throttled() slot acquired by the caller.
async function fetchWithRetry(url, attempt = 0) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "over18=1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    return fetchWithRetry(url, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

async function fetchHtml(url, { priority = false } = {}) {
  return throttled(() => fetchWithRetry(url), { priority });
}

function parseCount(text) {
  if (!text) return 0;
  const m = String(text).replace(/,/g, "").match(/([\d.]+)\s*([km])?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2]) n *= m[2].toLowerCase() === "k" ? 1e3 : 1e6;
  return Math.round(n);
}

// --- Subreddit discovery ---------------------------------------------------

export async function searchSubreddits(keyword) {
  const url = `https://old.reddit.com/subreddits/search?q=${encodeURIComponent(keyword)}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results = [];
  $("div.search-result-subreddit").each((_, el) => {
    const $el = $(el);
    const title = $el.find("a.search-subreddit-link").text().trim(); // "r/MachineLearning"
    const name = title.replace(/^r\//, "");
    if (!name) return;
    results.push({
      name,
      subscribers: parseCount($el.find(".search-subscribers").text()),
      description: $el.find(".search-result-body").text().trim().slice(0, 300),
      url: `https://old.reddit.com/r/${name}/`,
    });
  });
  // Fallback for alternate markup
  if (results.length === 0) {
    $("div.subreddit").each((_, el) => {
      const $el = $(el);
      const name = ($el.find("a.title").attr("href") || "").match(/\/r\/([^/]+)/)?.[1];
      if (!name) return;
      results.push({
        name,
        subscribers: parseCount($el.find(".subscribers .number").text()),
        description: $el.find(".description").text().trim().slice(0, 300),
        url: `https://old.reddit.com/r/${name}/`,
      });
    });
  }
  return results;
}

// --- Thread listing for a watched subreddit --------------------------------

async function fetchListing(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const posts = [];
  $("div.thing.link").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("promoted")) return;
    const permalink = $el.attr("data-permalink");
    if (!permalink) return;
    const createdMs = Number($el.attr("data-timestamp")) || null;
    posts.push({
      id: $el.attr("data-fullname"),
      title: $el.find("a.title").first().text().trim(),
      permalink: `https://old.reddit.com${permalink}`,
      score: parseCount($el.attr("data-score") ?? $el.find(".score.unvoted").attr("title")),
      numComments: parseCount($el.attr("data-comments-count")),
      createdMs,
      ageHours: createdMs ? (Date.now() - createdMs) / 36e5 : null,
      flair: $el.find(".linkflairlabel").first().text().trim() || null,
      // Listing pages never include the post body itself (verified: 0/18
      // self-posts in a sample listing had any text in .expando) — only
      // whether it's a self-post is available here, to decide whether a
      // separate body fetch is even worth making (link posts have none).
      isSelf: $el.hasClass("self"),
    });
  });
  return posts;
}

export async function fetchSubredditPosts(sub) {
  // Just "new" — the feed is a reverse-chronological view, not an opportunity
  // ranking, so the extra "hot" listing request per sub is no longer needed.
  // Halves request volume across a large watchlist.
  return fetchListing(`https://old.reddit.com/r/${sub}/new/`);
}

// --- Brand profile page (public user overview) ------------------------------

// maxPages walks old.reddit's `after` pagination cursor to go deeper than the
// first page (~25 items). Reddit's own listing API caps total visible history
// around 1000 items regardless of pagination depth, so very old activity may
// not be reachable — this fetches as much as is exposed, throttled the same
// as every other request.
export async function fetchUserProfile(profileUrl, { maxPages = 25 } = {}) {
  const m = profileUrl.match(/\/(?:user|u)\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("Profile URL must look like https://old.reddit.com/user/<handle>");
  const username = m[1];

  let postKarma = 0;
  let commentKarma = 0;
  const items = [];
  let after = null;
  let pagesScraped = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`https://old.reddit.com/user/${username}/`);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const html = await fetchHtml(url.toString());
    const $ = cheerio.load(html);
    if (page === 0) {
      postKarma = parseCount($(".titlebox .karma").first().text());
      commentKarma = parseCount($(".titlebox .comment-karma").first().text());
    }
    const pageItems = [];
    $("#siteTable > div.thing").each((_, el) => {
      const $el = $(el);
      const isComment = $el.hasClass("comment");
      const createdMs = Number($el.attr("data-timestamp")) || null;
      const permalink = $el.attr("data-permalink") || $el.find("a.bylink").attr("href") || "";
      pageItems.push({
        fullname: $el.attr("data-fullname"),
        kind: isComment ? "comment" : "post",
        sub: $el.attr("data-subreddit") || "",
        title: isComment
          ? $el.find("a.title").first().text().trim() ||
            $el.find(".parent a.title").first().text().trim()
          : $el.find("a.title").first().text().trim(),
        body: isComment ? $el.find(".usertext-body").first().text().trim().slice(0, 500) : "",
        score: parseCount(
          $el.attr("data-score") ?? $el.find(".score.unvoted").first().attr("title")
        ),
        createdMs,
        permalink: permalink ? `https://old.reddit.com${permalink}` : "",
      });
    });
    if (pageItems.length === 0) break;
    items.push(...pageItems);
    pagesScraped++;
    after = pageItems[pageItems.length - 1].fullname;
    if (!after || pageItems.length < 25) break; // reached the end of available history
  }

  return { username, postKarma, commentKarma, items, pagesScraped };
}

// --- Single thread (question body + comments) ------------------------------

// priority: true for the interactive "open this thread before drafting a
// reply" use — it must not sit behind hundreds of queued listing/body
// fetches from a scan in progress. The scan itself calls this too now (to
// read full post bodies, not just titles) and must leave priority off, or
// it would be queue-jumping over its own other requests for no reason.
export async function fetchThread(threadUrl, { priority = false } = {}) {
  const url = threadUrl.replace("www.reddit.com", "old.reddit.com");
  const html = await fetchHtml(url, { priority });
  const $ = cheerio.load(html);
  const $post = $("div.thing.link").first();
  const title = $post.find("a.title").first().text().trim();
  const selftext = $post.find(".expando .usertext-body").text().trim();
  const comments = [];
  $("div.commentarea div.thing.comment").each((_, el) => {
    const $el = $(el);
    const body = $el.find("> .entry .usertext-body").first().text().trim();
    if (!body) return;
    comments.push({
      author: $el.attr("data-author") || "[deleted]",
      body: body.slice(0, 2000),
      score: parseCount($el.find("> .entry .score.unvoted").first().text()),
    });
  });
  return {
    title,
    selftext,
    numComments: comments.length,
    comments,
  };
}
