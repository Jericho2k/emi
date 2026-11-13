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

## Telegram conversation context

Commands and the confirmations Emi actually sends are saved in the same
conversation history as chat. `/key` arguments are redacted before storage;
the key itself is still stored only in its encrypted field. In model context,
commands are labeled as user commands and their confirmations as app-generated
responses, so Emi can distinguish the app's actions from her own generated
replies. These labels appear only in model context; Telegram messages, stored
text, and Emi's persona stay unchanged. Existing saved command exchanges get
the labels when read, without a database migration.

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

## How it works

**A turn** (`src/core/pipeline.ts`) makes one model call, plus one small embedding. The prompt is ordered so providers can cache it: the persona first, then the history in a window that moves in blocks of twenty, then the notes that change every turn (local time, recalled memories, things to bring up).

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

## Not built yet

- Long-history consolidation (the folded timeline). History beyond the recent window is reachable only through extracted memories.
- A web page for memory; `/memory` and `/forget` cover it in chat for now.
- Voice, images and files.
- Streaming replies.
- Payments. Everyone uses their own key or the shared one.
