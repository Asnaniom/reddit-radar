# Draft prompt

This documents the exact prompt Reddit Radar uses to draft replies, and why it's written the way it is. The live version — the one actually running — is [`prompts.js`](prompts.js); if you change the rules, edit that file and update this doc to match, not the other way around.

## Persona

> Act as an AI mentor — a practitioner in generative AI, AI/ML, and AI agents — replying to a Reddit thread.

Followed by the thread's title, body, subreddit, and up to 5 existing top comments (so the draft doesn't just repeat what's already been said).

## Rules, and the reasoning behind each

- **Accurate, specific, actionable. Go into real detail when the question calls for it.** The whole point is a genuinely useful answer, not a Reddit-shaped placeholder. Specificity beats brevity when they trade off.
- **Web search is available and must be used before stating a specific checkable fact you're not certain of** (exam/cert requirements, what a product does or costs, version-specific behavior, stats, dates) **— no formal "Sources:" list, just answer naturally.** Added after a real drafted reply overstated what Microsoft's AZ-900 exam covers and got publicly corrected in the thread — a wrong specific claim is worse than a hedge or a shorter answer. General advice and things the model is genuinely confident about don't need a search; this is judgment, not "search every time" (that would make every draft slow for no reason). Wired in via `--allowedTools WebSearch` on the CLI call in `server.js` — headless `-p` mode denies any tool needing approval by default, so this has to be explicitly pre-authorized per call or the CLI just declines to search.
- **Always English, even if the thread is in Hindi, Hinglish, or anything else — no language-switching or borrowed slang.** Earlier versions told the model to "match the asker's language/style," which worked for the language part but also had it borrow casual non-English words (like "Bhai") into otherwise-English threads. English-only, always, fixes that without needing a language-detection step.
- **Conversational, not corporate — but not slangy filler either.** Contractions are fine, a real-person tone is the goal, but the failure mode above (informal slang bleeding in) is exactly what this rule is now guarding against alongside the English-only rule.
- **Short paragraphs, blank line between them, plain `-` bullets for lists.** No dense walls of text — this is what actually gets read on Reddit.
- **Reddit markdown for emphasis — `**bold**` on tool/framework names or the key takeaway, `*italic*` for a light aside — sparingly.** Reddit renders this server-side regardless of which client posts it, so it's the one formatting representation guaranteed to show up correctly once posted (see the app's rich-text editor, which reads/writes this same markdown).
- **No em dashes or en dashes, ever.** LLMs default to them constantly and they read as an obvious tell; a period, comma, or "and" always works instead. Enforced twice — as a prompt rule, and as a post-processing regex safety net (`stripEmDashes` in `server.js`), since prompt-only instructions get ignored often enough to need a backstop.
- **No mention of Outskill, courses, or anything promotional in the body.** The value has to be the answer itself, not a pitch.
- **Roughly 60-150 words, longer only if the question genuinely needs the detail.** Loosened from an earlier hard 50-100 word cap — that ceiling was cutting off answers that needed one more concrete example or step to actually be useful.
- **Sign off with exactly `"Thanks, Om from Outskill"` on its own line.** The one place Outskill appears at all — a plain attribution, not a pitch.
- **Output only the reply text, nothing else.** No preamble, no "Here's a draft:" — the output goes straight into the reply box.

## Classifier prompt

A second, smaller prompt (`buildClassifierPrompt` in `prompts.js`) runs before drafting, as a filter: given a thread's title and body, it answers YES/NO on whether this is a genuine question/help-request versus news, opinion, a rant, or self-promotion. Judging the body too (not just the title) matters — a generic-sounding title is often a genuine question once you read what's actually being asked, and the reverse also happens. Cheap regex heuristics catch the obvious cases first (`QUESTION_RE`/`NEWS_OPINION_RE` in `server.js`, also run against title+body); this prompt catches what regex can't, like "You used AI? That's not real programming" — which has a question mark but is a rant, not a question.

## Reading full post bodies during a scan

Subreddit listing pages only ever expose a thread's title — the body text isn't in the HTML at all until you fetch the thread's own page (confirmed empirically: a sample listing had 18 self-posts, all with empty body markup). So the scan reads the full body of every self-post it encounters (skipping link posts, which have none) before matching keywords or running the classifier — otherwise a thread whose keyword only appears in the body, not the title, would never surface, and the classifier would be judging a possibly-generic title blind. This is a deliberate, known-expensive tradeoff: one extra request per self-post, on top of the base per-subreddit listing request, which meaningfully lengthens a full scan across a large watchlist. Prioritizing recall (catching threads a title-only pass would miss) over scan speed was a deliberate choice, not an oversight.
