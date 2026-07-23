// One-time setup: opens a real Chrome window against a persistent profile so
// you can log into ChatGPT manually (use email + password, not "Continue with
// Google" — Google blocks automated browsers on its own OAuth screen). The
// login is saved to data/chatgpt-profile and reused by the server afterward.
//
// Run this yourself in your own Terminal (not via an automated tool) — it
// waits for you to confirm login is actually done before closing, rather
// than guessing from page state, which was unreliable (guest chat and the
// login redirect both produce page states that look like "logged in" for a
// moment even when it isn't).
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "chatgpt-profile");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1100, height: 900 },
});
const page = await context.newPage();
await page.goto("https://chatgpt.com/");

console.log("\nLog into ChatGPT in the window that opened, using email + password");
console.log("(NOT \"Continue with Google\" — that gets blocked).");
console.log("Make sure you land on the real chat screen with your account visible");
console.log("in the bottom-left of the sidebar (not the \"Log in / Sign up\" guest view).\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question("Once you're actually logged in, press Enter here... ", resolve));
rl.close();

await context.close();
console.log("Saved. The server can now use this login for drafting.");
