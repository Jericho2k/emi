# Emi

Emi is a chat companion who is also a capable assistant. There is one conversation and it never resets. She answers questions and does tasks like any assistant, remembers what you tell her, reminds you of things you asked about, and sometimes checks in the way a friend would.

She runs as a Telegram bot. The core knows nothing about Telegram, so another channel (an app with an avatar, for example) is a second adapter on the same core.

## Run it

You need Node 22+, a Postgres database with the `pgvector` extension (a Supabase project works as is), and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`, then:

```bash
npm start
```

Migrations are applied on start. `EMI_MASTER_KEY` encrypts users' API keys; generate one with:

```bash
openssl rand -base64 32
```

Each person brings their own OpenRouter key with `/key`. Set `EMI_SHARED_OPENROUTER_KEY` to cover people who have not set one, and `EMI_ALLOWED_TELEGRAM_IDS` to limit who can talk to the bot.

```bash
npm test
```

```bash
npm run typecheck
```

## Try her in a terminal

To talk to Emi with real models but no Telegram and no database, using a throwaway in-process Postgres:

```bash
OPENROUTER=sk-or-... npm run live
```

Type `+3h` or `+1d` to move the clock forward and let her act on her own, and `/memory`, `/agenda` or `/usage` to see her state. To replay a scripted conversation:

```bash
OPENROUTER=sk-or-... npm run live scripts/scenario.txt
```

The key is read from the environment only. Never put it in a file in this repository.

## What a person can control

| Command | What it does |
|---|---|
| `/key <key>` | Use your own OpenRouter key. Stored encrypted; the message is deleted. |
| `/memory` | Everything Emi knows about you. |
| `/remember <text>` | Tell her something to keep. Pinned, never rewritten by a model. |
| `/forget <id>` | Remove one memory. The text is erased, not hidden. |
| `/agenda` | What she plans to bring up, and when. |
| `/initiative off\|low\|medium\|high` | How often she writes first. |
| `/timezone <Area/City>` | Where you are. Telling her your city in chat works too. |
| `/quiet <from> <to>` | Hours she stays silent. |
| `/usage`, `/cap <usd>` | Today's cost, and the daily limit on what she spends unasked. |
| `/export` | A JSON file with everything she holds: messages, memories, plans, timeline and settings. Never the API key. |
| `/wipe yes` | Erases the whole conversation and everything learned from it. Settings and the key stay. |

## Telegram conversation context

Commands and the confirmations Emi actually sends are saved in the same
conversation history as chat. `/key` arguments are redacted before storage;
the key itself is still stored only in its encrypted field.

Emi sees commands, and she knows what they are. Her persona says that the
memory and the agenda are her own, lists the commands, and says the app
answers them without her. In model context a command and what the app
displayed both sit on the person's side of the history, as "they used a
command" followed by what was shown, so nothing she did not write is in her
voice. This framing matters: when the app was presented as a separate thing,
she disowned her own agenda and talked about transcripts. The wording exists
only in model context; Telegram messages and stored text are unchanged, and
saved command exchanges are reframed when read, with no migration.

Asking her in conversation to drop an agenda item or forget something works
like the commands do. The extractor closes the item or erases the memory, and
only when the request is quoted from the person's own message.

Replies carry a separate snapshot of the original text or caption and any
selected quote, including replies to messages outside the recent history
window. Each message keeps its own reply context when several messages are
batched into one turn. When Telegram supplies only a quote, Emi gets that
quote; unavailable original content is explicitly marked as unavailable.

Telegram parsing lives in `src/channels/telegram-input.ts`. The core uses
channel-independent `IncomingMessage` and `ReplyContext` types and a shared
renderer for current messages, history, and extraction. Quoted words are not
accepted as evidence of a new personal fact, and command exchanges are not
re-extracted into memories. Commands and chat share a per-person queue.

Existing installations apply `0002_message_context.sql` automatically on
startup. Earlier command exchanges were never stored and cannot be recovered
unless Telegram includes them in a new reply.

## Images and screenshots

Send Emi a photo or a PNG, JPEG, WebP or GIF file, with an optional caption.
She can read screenshots, explain diagrams, inspect visible text/code, and
work through a task shown in the picture. For small text, send the original
image as a file so Telegram does not compress it. A tighter crop helps when
text is too small or blurry. Image understanding is fallible: Emi should say
what she cannot read confidently rather than inventing details.

Photos, image documents, photo albums and nearby text use the existing
per-person turn queue. Up to six image attachments can be handled in one
turn, with an 8 MB limit per image and 16 MB total. A text reply to an older
Telegram picture reattaches that picture's pixels with its original caption
and reply context, even if it is outside the recent history window.

Follow-up questions automatically include up to two of the most recent images
within the recent conversation window, subject to the same total limits.
Current images take priority. Older image placeholders and timeline summaries
contain no pixels; reply to or resend the original to inspect it again.
The writer receives actual image parts, not only a generated OCR summary.
Extraction, timeline consolidation and proactive jobs see textual attachment
markers and the conversation, without reprocessing image pixels or treating
visual guesses as facts explicitly stated by you.

The default DeepSeek writer accepts images, so no model change or extra API
key is required. If you choose a text-only writer, set `EMI_VISION_MODEL` to
an image-capable OpenRouter model; otherwise leave it blank to keep the same
writer. Every turn still uses Emi's existing persona, memories and history.
Image tokens and replayed pictures use OpenRouter credits and appear in
`/usage`. Web tools remain available alongside images, and image input also
works with `EMI_WEB_ENABLED=false`.

The Telegram adapter downloads images with bounded size/time, checks their
file signatures, and passes private bytes to the model. Token-bearing
Telegram download URLs never go into prompts or saved image references.
Image bytes are stored separately from text history in the private
`message_images` table, with owner-scoped loading and Row Level Security for
the Supabase Data API. `/wipe` deletes those bytes along with messages.
`/export` sends the JSON manifest and each original image as a separate file,
loading one image at a time so the archive does not become a huge base64 JSON
upload. Migration `0004_message_images.sql` runs automatically at startup.

Provider format: [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).

## Current information and links

Web search and link reading are enabled by default for replies to your messages.
Emi decides when to search, and can open a supplied URL rather than guessing
its contents. Try “look up the latest release of …” or “read this link and
summarize it: https://…”. She is instructed to verify changing facts, prefer
primary sources, check dates, and cite the retrieved pages with clickable
Markdown links. Provider citation annotations also supply a source-list
fallback when an answer omits their URLs.

This uses OpenRouter's [web search](https://openrouter.ai/docs/guides/features/server-tools/web-search)
and [web fetch](https://openrouter.ai/docs/guides/features/server-tools/web-fetch)
server tools through the Responses API, with the same writer model and
OpenRouter key. No additional search account/key is needed. Server tools are
currently beta and need to be permitted by your OpenRouter account/workspace
and selected model route. Unsupported or blocked web requests produce a clear
notice instead of silently falling back to unverified current claims.

Web usage costs extra OpenRouter credits. A request allows at most four tool
steps: up to two searches (three results each) and two page reads. Search
excerpts and page content are capped. An empty/incomplete answer may trigger
one recovery request, so those limits apply per attempt. Network failures do
not automatically replay a web request with potentially billed tool work.
OpenRouter's reported aggregate cost, including server tools and recovery
attempts, flows through `/usage`. `/cap` still controls unsolicited activity,
not replies you request. Set `EMI_WEB_ENABLED=false` in `.env` and restart to
disable web access. Memory extraction and proactive planning/check-ins do not
get web tools or generate unsolicited search charges.

Page contents are treated as untrusted reference material; they cannot grant
new tools or authorize actions. Search queries should contain only the minimum
relevant information. Private/login-only pages, paywalls, and some dynamic
pages may be unreadable; Emi should say when retrieval or verification fails.
The bot itself does not fetch arbitrary URLs on your machine: OpenRouter
executes the two read-only tools remotely.

## Provider failures and agenda extraction

The provider adapter reads visible text only, including typed text parts; it
never substitutes internal reasoning for a reply. It reserves at least 2,048
output tokens with low reasoning effort. Empty, truncated, or invalid JSON
answers get one recovery attempt with a larger budget (up to 8,192 tokens).
Refusals and rejected keys are not retried as empty answers. Diagnostics
include request ID, model, finish reason and token counts rather than prompts,
keys, page text or reasoning. Successful retries and exhausted failures retain
reported usage costs. A final reply failure is saved as an app-generated notice.

Failed extraction leaves its cursor unread and backs off from one minute up
to fifteen minutes, rather than spending credits on the same failed batch
every 30 seconds. Its failure no longer discards malformed JSON as “nothing
to remember”.

In `/agenda`, the subject is model-proposed, while “only if we're talking” is
a fixed display label for an item without a planned ping. Immediate chat
steps and command experiments should not become follow-ups. Extraction now
requires a concrete dated personal event for a follow-up; undated life context
can still become a memory, and explicitly requested reminders remain supported.
Existing agenda rows are not deleted by this update and expire normally.

## How it works

**A turn** (`src/core/pipeline.ts`) makes a writer request, plus one small embedding. The provider may execute bounded read-only web tools during the writer request and recover once from an unusable answer. The prompt is ordered so providers can cache it: the persona first, then the history in a window that moves in blocks of twenty, then the notes that change every turn (local time, recalled memories, things to bring up).

**After the reply** (`src/core/extraction.ts`), one cheap call proposes everything worth keeping: facts, events, follow-ups, settled items, how a check-in landed, mood, timezone. The model only proposes. Code checks every proposal: a fact needs an exact quote from the person, a time is converted and bounded by the application, and a replacement must pass the reconciliation rules.

**Memory** (`src/core/memory/`):

- Events are never retired, and two events on different days are never merged.
- States can be replaced by a newer one; the old row is kept and linked.
- Anything the person wrote or pinned is never rewritten.
- Recall is by relevance: a memory must reach half the strength of the turn's best match, so small talk recalls little and a long thread recalls a lot.
- Ageing uses real calendar time.

**Speaking first** (`src/core/agenda/`, `src/core/proactive.ts`). Emi keeps an agenda of three kinds of item:

- A **reminder** is something you asked to be told at a time. It is sent at that time, whatever else is going on.
- A **follow-up** is something in your future she wants to ask about afterwards. The model reports when your event is; code decides when she may speak.
- An **initiative** is her own reason to write, planned at most once a day, and only from memories she can cite. Most days the planner returns nothing.

If you write first, she raises a follow-up or initiative in that conversation, and its ping is cancelled. A ping needs several hours of silence, respects quiet hours and a daily budget, and is never sent while an earlier check-in is unanswered. The message is written at send time against the current conversation, and the writer may decide to hold it. Three brush-offs in a row lower her initiative one step.

**Long history** (`src/core/memory/timeline.ts`). The writer sees the newest 30 to 49 messages in full. When a block of 20 leaves that window, one cheap call writes an arc for exactly those messages: a chapter summary and a one-line headline. The newest arcs appear as headlines; a run of six arcs is folded once into a chapter, and a run of six chapters once into a part. Nothing folded is summarised again, so the order of events cannot drift, and the record grows only logarithmically with the length of the chat. It sits right after the persona in the prompt and changes only when a block is consolidated. When a turn is about an old chapter, that chapter's full summary is added to the turn's notes.

One limit to know: `/forget` erases a memory, but a chapter summary written earlier may still mention the same fact. `/wipe` erases everything.

## Deploy on Railway

Emi is a worker: she polls Telegram and runs a scheduler, and serves no HTTP. The repository has a `Dockerfile` and a `railway.toml`.

1. In Railway, create a project from this GitHub repository and pick the branch to deploy.
2. Under Variables, add `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` and `EMI_MASTER_KEY`, plus any optional ones from `.env.example`. Use the same `EMI_MASTER_KEY` you used before, or keys stored with `/key` can no longer be read.
3. For `DATABASE_URL` with Supabase, use the session pooler connection string (the host ending in `pooler.supabase.com`). Railway has no outbound IPv6, and Supabase's direct connection is IPv6 only.
4. Deploy. The log should show `[emi] running`. Migrations are applied on start.

Run exactly one instance. Stop any copy on your own machine first: two processes polling the same bot each receive only some of the messages, and Telegram answers one of them with a 409 conflict.

## Not built yet

- A web page for memory; `/memory` and `/forget` cover it in chat for now.
- Voice, video, and general document input beyond image files.
- Streaming replies.
- Payments. Everyone uses their own key or the shared one.
