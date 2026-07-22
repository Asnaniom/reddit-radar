const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const emptyState = (icon, text) => `<div class="empty-state"><span class="icon">${icon}</span>${esc(text)}</div>`;
const loadingLine = (text) => `<p class="muted">${esc(text)}<span class="spinner spinner-dark"></span></p>`;

function setBtnLoading(btn, loading, loadingText) {
  if (loading) {
    btn.dataset.label = btn.dataset.label || btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${esc(loadingText || "Working")}<span class="spinner"></span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// --- Tabs -------------------------------------------------------------------

document.querySelectorAll("#tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "discover") renderWatchList();
    if (btn.dataset.tab === "threads") loadGlobalKeywords();
    if (btn.dataset.tab === "posted") renderPosted();
    if (btn.dataset.tab === "logs") renderLogs();
    if (btn.dataset.tab === "profile") loadProfileSettings();
    if (btn.dataset.tab === "account") loadAccountTab();
  });
});

// --- Discover ---------------------------------------------------------------

function parseSubredditInput(raw) {
  const s = raw.trim();
  const m = s.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i) || s.match(/^\/?r\/([A-Za-z0-9_]+)/i);
  return (m ? m[1] : s).trim();
}

$("#quick-add-btn").addEventListener("click", async () => {
  const btn = $("#quick-add-btn");
  const name = parseSubredditInput($("#quick-add-input").value);
  if (!name) {
    $("#quick-add-status").innerHTML = `<span class="error">Paste a subreddit link or name first.</span>`;
    return;
  }
  setBtnLoading(btn, true, "Adding");
  $("#quick-add-status").textContent = "";
  try {
    await api("/api/watch", { method: "POST", body: { name } });
    $("#quick-add-status").textContent = `✓ Now watching r/${name}`;
    $("#quick-add-input").value = "";
    renderWatchList();
  } catch (err) {
    $("#quick-add-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    setBtnLoading(btn, false);
  }
});
$("#quick-add-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#quick-add-btn").click(); }
});

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  const submitBtn = $("#search-form button[type=submit]");
  setBtnLoading(submitBtn, true, "Searching");
  $("#search-status").textContent = "";
  $("#search-results").innerHTML = "";
  try {
    const results = await api(`/api/search-subreddits?q=${encodeURIComponent(q)}`);
    $("#search-status").textContent = `${results.length} subreddits found`;
    $("#search-results").innerHTML = results.length === 0
      ? emptyState("🔍", "No subreddits matched that keyword — try something broader.")
      : results
      .map(
        (r) => `
      <div class="card">
        <h3><a href="${esc(r.url)}" target="_blank" rel="noopener">r/${esc(r.name)}</a></h3>
        <div class="meta">${r.subscribers > 0 ? r.subscribers.toLocaleString() + " subscribers" : ""}</div>
        <div class="desc">${esc(r.description)}</div>
        <div class="actions">
          <button data-watch="${esc(r.name)}" class="${r.watching ? "watching" : ""}">
            ${r.watching ? "✓ Watching" : "+ Watch"}
          </button>
        </div>
      </div>`
      )
      .join("");
    document.querySelectorAll("[data-watch]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api("/api/watch", { method: "POST", body: { name: b.dataset.watch } });
        b.textContent = "✓ Watching";
        b.classList.add("watching");
        renderWatchList();
      })
    );
  } catch (err) {
    $("#search-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    setBtnLoading(submitBtn, false);
  }
});

// --- Watch list -------------------------------------------------------------

async function loadGlobalKeywords() {
  const { keywords } = await api("/api/keywords");
  $("#global-keywords").value = keywords.join(", ");
}

$("#keywords-save-btn").addEventListener("click", async () => {
  const keywords = $("#global-keywords").value.split(",").map((s) => s.trim()).filter(Boolean);
  await api("/api/keywords", { method: "PUT", body: { keywords } });
  $("#keywords-status").textContent = `Saved ${keywords.length} keyword(s) — applied to every watched subreddit.`;
});

async function renderWatchList() {
  const { watch, lastRefresh } = await api("/api/watch");
  if (lastRefresh) {
    const s = $("#refresh-status");
    if (s) s.textContent = `Last refresh: ${new Date(lastRefresh).toLocaleString()}`;
  }
  if (watch.length === 0) {
    $("#watch-list").innerHTML = emptyState("👁", "No subreddits watched yet — add one above or search for one.");
    return;
  }
  $("#watch-list").innerHTML = `
    <p class="muted">${watch.length} subreddit(s) watched</p>
    <div class="chip-list">
      ${watch
        .map(
          (w) => `<span class="chip">r/${esc(w.name)} <button data-unwatch="${esc(w.name)}" title="Unwatch">×</button></span>`
        )
        .join("")}
    </div>`;
  document.querySelectorAll("[data-unwatch]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Remove r/${b.dataset.unwatch} from your watchlist?`)) return;
      await api(`/api/watch/${encodeURIComponent(b.dataset.unwatch)}`, { method: "DELETE" });
      renderWatchList();
    })
  );
}

// --- Threads: reverse-chronological feed with inline reply -------------------

let feedThreads = []; // keyed by index for card lookups

function threadCardHtml(t, i) {
  return `
    <div class="card" data-card="${i}">
      <h3><a href="${esc(t.permalink)}" target="_blank" rel="noopener">${esc(t.title)}</a></h3>
      <div class="meta">
        <span class="badge gray">r/${esc(t.sub)}</span>
        <span class="badge green">score ${t.opportunity}</span>
        ${t.matchedKeywords.map((k) => `<span class="badge">${esc(k)}</span>`).join("")}
        · ${t.score} upvotes · ${t.numComments} comments · ${t.ageHours != null ? Math.round(t.ageHours) + "h old" : ""}
      </div>
      <div class="reply-area">
        <button class="primary" data-reply="${i}">💬 Reply</button>
      </div>
    </div>`;
}

async function loadThreadFeed() {
  const btn = $("#refresh-btn");
  setBtnLoading(btn, true, "Scanning");
  $("#refresh-status").textContent = "Scanning watched subreddits (throttled, ~2s per sub)…";
  try {
    const { results, errors, classifierAvailable } = await api("/api/refresh", { method: "POST" });
    feedThreads = results;
    $("#refresh-status").textContent =
      `${results.length} educational-question threads, newest first` +
      (errors.length ? ` · ${errors.length} sub(s) failed` : "") +
      (classifierAvailable === false ? " · AI classifier unavailable, used heuristic filter only" : "");
    $("#thread-feed").innerHTML = results.length
      ? results.map((t, i) => threadCardHtml(t, i)).join("")
      : emptyState("🔎", "No genuine questions matched your keywords yet. Try broadening the keyword list above.");
    document.querySelectorAll("[data-reply]").forEach((b) => b.addEventListener("click", () => handleReply(Number(b.dataset.reply))));
  } catch (err) {
    $("#refresh-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    setBtnLoading(btn, false);
  }
}
$("#refresh-btn").addEventListener("click", loadThreadFeed);

async function handleReply(i) {
  const t = feedThreads[i];
  const area = document.querySelector(`[data-card="${i}"] .reply-area`);
  const replyBtn = area.querySelector("[data-reply]");
  setBtnLoading(replyBtn, true, "Replying");
  try {
    const thread = await api(`/api/thread?url=${encodeURIComponent(t.permalink)}`);
    const d = await api("/api/draft", {
      method: "POST",
      body: {
        title: thread.title || t.title,
        selftext: thread.selftext,
        sub: t.sub,
        topComments: thread.comments.slice(0, 5).map((c) => c.body),
      },
    });
    let tracked = false;
    area.innerHTML = `
      ${d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}
      <textarea class="draft-text" rows="6">${esc(d.draft || "")}</textarea>
      <div class="actions">
        <button class="primary" data-copy-open>📋 Copy & open thread</button>
        <span class="reply-note"></span>
      </div>`;
    area.querySelector("[data-copy-open]").addEventListener("click", async () => {
      const text = area.querySelector(".draft-text").value;
      await navigator.clipboard.writeText(text);
      window.open(t.permalink, "_blank", "noopener");
      const note = area.querySelector(".reply-note");
      if (!tracked) {
        try {
          await api("/api/posted", {
            method: "POST",
            body: { threadUrl: t.permalink, title: thread.title || t.title, sub: t.sub, comment: text },
          });
          tracked = true;
          note.innerHTML = `<span class="copy-note">Copied, opened, and tracked under Posted.</span>`;
        } catch {
          note.innerHTML = `<span class="copy-note">Copied and opened.</span>`;
        }
      } else {
        note.innerHTML = `<span class="copy-note">Copied and opened again.</span>`;
      }
    });
  } catch (err) {
    area.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    if (area.querySelector("[data-reply]")) setBtnLoading(replyBtn, false);
  }
}

// --- Posted tab -------------------------------------------------------------

async function renderPosted() {
  const posted = await api("/api/posted");
  $("#posted-list").innerHTML =
    posted
      .map(
        (p) => `
    <div class="card">
      <h3><a href="${esc(p.threadUrl)}" target="_blank" rel="noopener">${esc(p.title || p.threadUrl)}</a></h3>
      <div class="meta">
        <span class="badge gray">r/${esc(p.sub)}</span>
        ${p.status === "found" ? '<span class="badge green">✓ answer live on thread</span>' : p.status === "not-found" ? '<span class="badge">not found yet</span>' : '<span class="badge gray">pending check</span>'}
        · posted ${new Date(p.postedAt).toLocaleString()}
        ${p.lastCheckedAt ? " · checked " + new Date(p.lastCheckedAt).toLocaleString() : ""}
      </div>
      <div class="comment-preview">${esc(p.comment.slice(0, 300))}</div>
      <div class="actions"><button data-untrack="${esc(p.threadUrl)}">Remove</button></div>
    </div>`
      )
      .join("") || emptyState("💬", "Nothing tracked yet — reply to a thread from the Threads tab and it'll show up here once you copy & post it.");
  document.querySelectorAll("[data-untrack]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/posted", { method: "DELETE", body: { threadUrl: b.dataset.untrack } });
      renderPosted();
    })
  );
}

$("#check-posted-btn").addEventListener("click", async () => {
  const btn = $("#check-posted-btn");
  setBtnLoading(btn, true, "Checking");
  $("#posted-status").textContent = "Re-scraping tracked threads…";
  try {
    const { posted, errors } = await api("/api/check-posted", { method: "POST" });
    $("#posted-status").textContent = `Checked ${posted.length} thread(s)` + (errors.length ? ` · ${errors.length} failed` : "");
    renderPosted();
  } catch (err) {
    $("#posted-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    setBtnLoading(btn, false);
  }
});

// --- Watch Account tab (paste subscription list once) -----------------------

async function loadAccountTab() {
  const { watch } = await api("/api/watch");
  $("#account-results").innerHTML = watch.length
    ? `<h2>Currently watching (${watch.length})</h2>
       <div class="chip-list">${watch.map((w) => `<span class="chip">r/${esc(w.name)}</span>`).join("")}</div>`
    : emptyState("🎯", "Nothing watched yet — paste a subreddit list above.");
}

$("#account-watch-all-btn").addEventListener("click", async () => {
  const btn = $("#account-watch-all-btn");
  const names = $("#account-paste").value.trim();
  if (!names) {
    $("#account-status").innerHTML = `<span class="error">Paste at least one subreddit name first.</span>`;
    return;
  }
  setBtnLoading(btn, true, "Adding");
  $("#account-status").textContent = "";
  try {
    const r = await api("/api/watch-bulk", { method: "POST", body: { names } });
    $("#account-status").textContent = `Added ${r.added} new (of ${r.total} pasted)`;
    $("#account-paste").value = "";
    loadAccountTab();
  } catch (err) {
    $("#account-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    setBtnLoading(btn, false);
  }
});

// --- Profile tab ------------------------------------------------------------

async function loadProfileSettings() {
  const s = await api("/api/settings");
  $("#profile-url").value = s.profileUrl || "";
  $("#outskill-context").value = s.outskillContext || "";
  if (s.profileUrl) fetchProfile();
}

async function fetchProfile() {
  const btn = $("#profile-fetch-btn");
  setBtnLoading(btn, true, "Fetching");
  $("#profile-status").textContent = "";
  $("#profile-view").innerHTML = loadingLine("Fetching profile from old.reddit.com…");
  try {
    const p = await api("/api/profile");
    if (!p.configured) {
      $("#profile-status").textContent = "Set the brand handle URL first.";
      $("#profile-view").innerHTML = "";
      return;
    }
    $("#profile-status").textContent = "";
    $("#profile-view").innerHTML = `
      <div class="card">
        <h3>u/${esc(p.username)}</h3>
        <div class="meta">
          <span class="badge">⬆ ${p.postKarma.toLocaleString()} post karma</span>
          <span class="badge">💬 ${p.commentKarma.toLocaleString()} comment karma</span>
        </div>
      </div>
      <h2>Recent activity</h2>
      ${p.items
        .map(
          (i) => `
        <div class="card">
          <div class="meta">
            <span class="badge ${i.kind === "comment" ? "gray" : "green"}">${i.kind}</span>
            <span class="badge gray">r/${esc(i.sub)}</span>
            · ${i.score} points ${i.createdMs ? "· " + new Date(i.createdMs).toLocaleString() : ""}
          </div>
          ${i.title ? `<h3>${i.permalink ? `<a href="${esc(i.permalink)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</h3>` : ""}
          ${i.body ? `<div class="comment-preview">${esc(i.body.slice(0, 280))}</div>` : ""}
        </div>`
        )
        .join("") || emptyState("👤", "No public activity found yet.")}`;
  } catch (err) {
    $("#profile-status").innerHTML = `<span class="error">${esc(err.message)}</span>`;
    $("#profile-view").innerHTML = "";
  } finally {
    setBtnLoading(btn, false);
  }
}

$("#profile-save-btn").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", body: { profileUrl: $("#profile-url").value } });
  $("#profile-status").textContent = "Saved.";
});
$("#profile-fetch-btn").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", body: { profileUrl: $("#profile-url").value } });
  fetchProfile();
});
$("#context-save-btn").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", body: { outskillContext: $("#outskill-context").value } });
  $("#context-status").textContent = "Saved — future drafts will use this.";
});

// --- Logs tab ---------------------------------------------------------------

async function renderLogs() {
  const logs = await api("/api/logs");
  $("#logs-status").textContent = `${logs.length} entries (newest first, capped at 500)`;
  $("#logs-list").innerHTML =
    logs
      .map(
        (l) => `
    <div class="log-row">
      <span class="log-time">${new Date(l.at).toLocaleString()}</span>
      <span class="log-type ${esc(l.type)}">${esc(l.type)}</span>
      <span class="log-msg">${esc(l.message)}</span>
    </div>`
      )
      .join("") || emptyState("📜", "Nothing logged yet — every search, scan, draft, and check will show up here.");
}

$("#logs-refresh-btn").addEventListener("click", async () => {
  const btn = $("#logs-refresh-btn");
  setBtnLoading(btn, true, "Reloading");
  try {
    await renderLogs();
  } finally {
    setBtnLoading(btn, false);
  }
});
$("#logs-clear-btn").addEventListener("click", async () => {
  await api("/api/logs", { method: "DELETE" });
  renderLogs();
});

renderWatchList();
loadGlobalKeywords();
