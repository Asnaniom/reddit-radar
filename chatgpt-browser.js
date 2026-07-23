// Drives a real, logged-in Chrome profile against chatgpt.com to generate
// drafts using an existing ChatGPT Plus subscription instead of API credits.
// No official automation support exists for this (unlike Claude Code's CLI)
// — selectors here WILL break when OpenAI changes their page. Each call opens
// a fresh conversation with the full prompt; there's no benefit to a shared
// thread since every Reddit question is independent.
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "chatgpt-profile");
const RESPONSE_TIMEOUT_MS = 90000;

let contextPromise = null;

function getContext() {
  if (!contextPromise) {
    contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1100, height: 900 },
    });
  }
  return contextPromise;
}

// ChatGPT allows anonymous guest chat now, so a visible message box is NOT
// proof of login — a visible "Log in" button is the reliable signal of being
// logged OUT.
async function checkLoggedIn(page) {
  const loginVisible = await page
    .getByRole("button", { name: /log in/i })
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);
  return !loginVisible;
}

export async function isLoggedIn() {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    return await checkLoggedIn(page);
  } finally {
    await page.close();
  }
}

export async function draftViaChatGPT(prompt) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });

    if (!(await checkLoggedIn(page))) {
      throw new Error(
        "Not logged into ChatGPT in the automation browser profile — run `npm run chatgpt-login` once."
      );
    }
    const input = page.locator("#prompt-textarea");
    await input.waitFor({ state: "visible", timeout: 10000 });

    await input.click();
    await input.fill(prompt);
    await page.keyboard.press("Enter");

    // Wait for a reply to start, then for the "stop generating" control to
    // disappear (streaming finished), then read the last assistant message.
    await page.locator('[data-message-author-role="assistant"]').last().waitFor({ timeout: 20000 });
    await page
      .locator('button[data-testid="stop-button"]')
      .waitFor({ state: "detached", timeout: RESPONSE_TIMEOUT_MS })
      .catch(() => {}); // if it never appeared/detected, fall through and read whatever is there

    const messages = page.locator('[data-message-author-role="assistant"]');
    const count = await messages.count();
    const text = (await messages.nth(count - 1).innerText()).trim();
    if (!text) throw new Error("ChatGPT returned an empty response");
    return text;
  } finally {
    await page.close();
  }
}
