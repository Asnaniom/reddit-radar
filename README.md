# Reddit Radar

Scrapes watched subreddits for threads matching your keywords, drafts a reply, and tracks whether you've posted it. Everything happens locally — no Reddit account or API key is used for scraping (old.reddit.com only), and drafting uses your own local Claude Code login.

## Setup

1. Install the [Claude Code CLI](https://docs.claude.com/claude-code) and log in (`claude` on the command line — this is what drafts replies, so it must work before you run the app).
2. `npm install`
3. `npm start` — runs at `http://localhost:4321`

First run seeds the watchlist and keywords from `data/seed.json` (the shared starting point). After that, your own `data/data.json` takes over and evolves independently — refreshes, posted history, and dismissed threads are local to your machine, not synced with anyone else's copy.

## Chrome extension

Lives in `extension/` and talks to your locally-running server (`npm start` must be running for it to work — it's a thin client, not a standalone app).

- **Popup** (click the toolbar icon): the same Feed/Add Subreddit/Posted/Logs app, in a popup.
- **On-page button**: browsing a Reddit thread whose title matches one of your keywords shows a floating "🤖 Draft AI Reply" button. Clicking it drafts a reply in a rich text panel (bold/italic, editable) right on the page — no switching tabs. "Insert into comment box" tries to drop it straight into Reddit's own comment box (reliable on old.reddit.com's plain textarea; best-effort on new Reddit's rich editor, since it's a moving target across redesigns); "Copy" always works as a sure-fire fallback.

**To install** (not published to the Chrome Web Store — load it as an unpacked extension):
1. Go to `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked**, select the `extension/` folder.
3. Make sure `npm start` is running, then visit any Reddit thread.
