// Reddit Radar popup — detects the Reddit thread on the active tab, drafts
// a reply for it, and tracks it to the web app's Posted tab. Talks to the
// local server directly: popup pages (unlike content scripts) aren't
// subject to the page's own CORS policy, so no background-worker relay is
// needed as long as localhost:4321 is declared in manifest host_permissions.

const SERVER = "http://localhost:4321";
const app = document.getElementById("app");

async function apiFetch(path, options) {
  const res = await fetch(`${SERVER}${path}`, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// --- Reddit-markdown <-> rich text (same logic as the web app) -------------

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

// --- Main flow ---------------------------------------------------------------

function threadMetaFromUrl(url) {
  const m = url.match(/^https:\/\/(?:www|old)\.reddit\.com\/r\/([^/]+)\/comments\//i);
  if (!m) return null;
  return { sub: m[1], permalink: url.split("?")[0] };
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const meta = tab?.url ? threadMetaFromUrl(tab.url) : null;
  if (!meta) {
    app.innerHTML = `<div class="rr-status">Open a Reddit thread (a specific post, not a listing page) to draft a reply here.</div>`;
    return;
  }

  app.innerHTML = `<div class="rr-status">Reading the thread…</div>`;
  let thread, draft;
  try {
    thread = await apiFetch(`/api/thread?url=${encodeURIComponent(meta.permalink)}`);
    app.innerHTML = `<div class="rr-status">Drafting…</div>`;
    draft = await apiFetch("/api/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: thread.title,
        selftext: thread.selftext,
        sub: meta.sub,
        topComments: (thread.comments || []).slice(0, 5).map((c) => c.body),
      }),
    });
  } catch (err) {
    app.innerHTML = `<div class="rr-error">${escMd(err.message)}${
      err.message.includes("fetch") ? " — is the Reddit Radar server running at localhost:4321?" : ""
    }</div>`;
    return;
  }

  renderDraft(meta, thread, draft);
}

function renderDraft(meta, thread, d) {
  let tracked = false;
  app.innerHTML = `
    <div class="rr-thread-title">${escMd(thread.title || meta.permalink)}</div>
    ${d.note ? `<div class="rr-status">${escMd(d.note)}</div>` : ""}
    <div class="rr-toolbar">
      <button type="button" data-fmt="bold" title="Bold"><b>B</b></button>
      <button type="button" data-fmt="italic" title="Italic"><i>I</i></button>
      <button type="button" data-fmt="underline" title="Underline (only shows up if pasted into Reddit's rich comment box)"><u>U</u></button>
    </div>
    <div class="rr-draft" contenteditable="true">${markdownToHtml(d.draft || "")}</div>
    <div class="rr-actions">
      <button class="rr-primary" data-copy>📋 Copy Response</button>
    </div>
    <div class="rr-note"></div>
  `;
  const draftEl = app.querySelector(".rr-draft");
  const note = app.querySelector(".rr-note");

  app.querySelectorAll("[data-fmt]").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.execCommand(b.dataset.fmt);
    })
  );

  async function track(text) {
    if (tracked) return;
    try {
      await apiFetch("/api/posted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadUrl: meta.permalink, title: thread.title, sub: meta.sub, comment: text }),
      });
      tracked = true;
    } catch {
      // non-fatal — the reply itself already happened from the user's POV
    }
  }

  app.querySelector("[data-copy]").addEventListener("click", async () => {
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

init();
