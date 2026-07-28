// Reddit Radar content script — runs on reddit.com thread pages. Talks to
// the local Reddit Radar server (must be running at localhost:4321) via the
// background service worker, which avoids the page's own CORS restrictions.

function rrFetch(path, options) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "rr-fetch", path, options }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("No response from Reddit Radar — is the local server running at localhost:4321?"));
      if (!res.ok) return reject(new Error(res.error || res.data?.error || `HTTP ${res.status}`));
      resolve(res.data);
    });
  });
}

// --- Reddit-markdown <-> rich text (same logic as the web app's app.js) ----

function escMd(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function inlineMdToHtml(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
}
function markdownToHtml(md) {
  return (md || "")
    .split(/\n\s*\n/)
    .map((para) => {
      const lines = para.split("\n").filter((l) => l.trim() !== "");
      if (lines.length && lines.every((l) => /^\s*-\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inlineMdToHtml(escMd(l.replace(/^\s*-\s+/, "")))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map((l) => inlineMdToHtml(escMd(l))).join("<br>")}</p>`;
    })
    .join("");
}
function htmlToMarkdown(root) {
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const inner = Array.from(node.childNodes).map(walk).join("");
    switch (node.tagName.toLowerCase()) {
      case "strong": case "b": return `**${inner}**`;
      case "em": case "i": return `*${inner}*`;
      case "li": return `- ${inner}\n`;
      case "br": return "\n";
      case "div": case "p": case "ul": case "ol": return `${inner}\n\n`;
      default: return inner;
    }
  }
  return Array.from(root.childNodes)
    .map(walk)
    .join("")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Thread detection --------------------------------------------------------

function getThreadMeta() {
  const m = location.pathname.match(/^\/r\/([^/]+)\/comments\//i);
  if (!m) return null;
  const title = document.querySelector('meta[property="og:title"]')?.content || document.title;
  return { sub: m[1], title, permalink: location.href.split("?")[0] };
}

function matchesKeywords(title, keywords) {
  return keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title));
}

// --- Insertion into Reddit's own comment box (best-effort) ------------------
// Old Reddit's comment box is a plain <textarea> — reliable to fill directly.
// New Reddit's composer is a framework-owned rich editor whose internals
// change between redesigns; a synthetic paste event is the standard trick
// for handing it real content, but it's not guaranteed to land. Either way,
// the panel's own Copy button is always available as a sure-fire fallback.

function findOldRedditTextarea() {
  return document.querySelector(".commentarea form.usertext-edit textarea[name='text'], .commentarea textarea[name='text']");
}

function findNewRedditComposer() {
  return (
    document.querySelector('[data-testid="comment-submission-form-richtext"] [contenteditable="true"]') ||
    document.querySelector('shreddit-composer [contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]')
  );
}

function tryInsert(plainText, html) {
  const ta = findOldRedditTextarea();
  if (ta) {
    ta.focus();
    ta.value = (ta.value ? ta.value + "\n\n" : "") + plainText;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  const composer = findNewRedditComposer();
  if (composer) {
    composer.focus();
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", plainText);
      dt.setData("text/html", html);
      const pasteEvent = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      composer.dispatchEvent(pasteEvent);
      return true; // best-effort — Reddit's editor may or may not have handled it; not independently confirmable here
    } catch {
      return false;
    }
  }
  return false;
}

// --- UI ----------------------------------------------------------------------

let panelEl = null;

function closePanel() {
  panelEl?.remove();
  panelEl = null;
}

async function openPanel(meta) {
  closePanel();
  panelEl = document.createElement("div");
  panelEl.className = "rr-panel";
  panelEl.innerHTML = `
    <h4>🤖 Reddit Radar draft <button class="rr-close">✕</button></h4>
    <div class="rr-status">Drafting…</div>
  `;
  document.body.appendChild(panelEl);
  panelEl.querySelector(".rr-close").addEventListener("click", closePanel);

  try {
    const thread = await rrFetch(`/api/thread?url=${encodeURIComponent(meta.permalink)}`);
    const d = await rrFetch("/api/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: thread.title || meta.title,
        selftext: thread.selftext,
        sub: meta.sub,
        topComments: (thread.comments || []).slice(0, 5).map((c) => c.body),
      }),
    });
    if (!panelEl) return; // closed while awaiting
    renderDraft(meta, thread, d);
  } catch (err) {
    if (!panelEl) return;
    panelEl.querySelector(".rr-status").outerHTML = `<div class="rr-error">${escMd(err.message)}</div>`;
  }
}

function renderDraft(meta, thread, d) {
  let tracked = false;
  panelEl.innerHTML = `
    <h4>🤖 Reddit Radar draft <button class="rr-close">✕</button></h4>
    ${d.note ? `<div class="rr-status">${escMd(d.note)}</div>` : ""}
    <div class="rr-toolbar">
      <button type="button" data-fmt="bold" title="Bold"><b>B</b></button>
      <button type="button" data-fmt="italic" title="Italic"><i>I</i></button>
      <button type="button" data-fmt="underline" title="Underline (only shows up if pasted into Reddit's rich comment box)"><u>U</u></button>
    </div>
    <div class="rr-draft" contenteditable="true">${markdownToHtml(d.draft || "")}</div>
    <div class="rr-actions">
      <button class="rr-primary" data-insert>⚡ Insert into comment box</button>
      <button class="rr-secondary" data-copy>📋 Copy</button>
    </div>
    <div class="rr-note"></div>
  `;
  panelEl.querySelector(".rr-close").addEventListener("click", closePanel);
  const draftEl = panelEl.querySelector(".rr-draft");
  const note = panelEl.querySelector(".rr-note");

  panelEl.querySelectorAll("[data-fmt]").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.execCommand(b.dataset.fmt);
    })
  );

  async function track(text) {
    if (tracked) return;
    try {
      await rrFetch("/api/posted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadUrl: meta.permalink, title: thread.title || meta.title, sub: meta.sub, comment: text }),
      });
      tracked = true;
    } catch {
      // non-fatal — posting itself already happened from the user's POV
    }
  }

  panelEl.querySelector("[data-insert]").addEventListener("click", async () => {
    const text = htmlToMarkdown(draftEl);
    const inserted = tryInsert(text, draftEl.innerHTML);
    if (inserted) {
      note.textContent = "Inserted into the comment box below — review before posting.";
      await track(text);
    } else {
      note.textContent = "Couldn't find Reddit's comment box automatically — copying instead, paste with Cmd/Ctrl+V.";
      try {
        await navigator.clipboard.writeText(text);
      } catch { /* clipboard also failed — the draft is still visible to copy by hand */ }
    }
  });

  panelEl.querySelector("[data-copy]").addEventListener("click", async () => {
    const text = htmlToMarkdown(draftEl);
    let copyOk = true;
    try {
      if (navigator.clipboard.write && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([draftEl.innerHTML], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      copyOk = false;
    }
    note.textContent = copyOk ? "Copied — paste it into the comment box." : "Copy failed — select the text above and copy manually.";
    await track(text);
  });
}

// --- Bootstrap -----------------------------------------------------------------

async function init() {
  const meta = getThreadMeta();
  if (!meta) return;

  let keywords = [];
  try {
    const res = await rrFetch("/api/keywords");
    keywords = res.keywords || [];
  } catch {
    return; // server not running — nothing to do, fail silent rather than nag on every reddit page
  }
  if (keywords.length === 0 || matchesKeywords(meta.title, keywords).length === 0) return;

  const fab = document.createElement("button");
  fab.className = "rr-fab";
  fab.textContent = "🤖 Draft AI Reply";
  fab.addEventListener("click", () => openPanel(meta));
  document.body.appendChild(fab);
}

init();
