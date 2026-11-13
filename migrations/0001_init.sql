create extension if not exists vector;

-- One row per person. Everything Emi knows hangs off this id, never off a
-- Telegram id, so a second channel (the app) is a second row in
-- channel_identities and nothing else.
create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  timezone text not null default 'UTC',
  -- False until the person states where they are. Nothing time-based is
  -- scheduled against a guessed timezone.
  timezone_known boolean not null default false,
  initiative text not null default 'medium'
    check (initiative in ('off', 'low', 'medium', 'high')),
  -- Consecutive "leave me alone" reactions to a check-in. Three lower
  -- initiative by one step.
  brushoff_count integer not null default 0,
  quiet_start smallint not null default 23,
  quiet_end smallint not null default 8,
  -- Ceiling on what Emi may spend per local day on things she does unasked.
  daily_cap_usd numeric(10, 4) not null default 0.50,
  mood jsonb not null default '{}',
  encrypted_api_key text,
  last_user_message_at timestamptz,
  last_emi_message_at timestamptz,
  -- Highest message id the background extractor has read.
  extracted_through bigint not null default 0,
  last_planned_on date,
  created_at timestamptz not null
);

create table channel_identities (
  channel text not null,
  external_id text not null,
  user_id uuid not null references users (id) on delete cascade,
  chat_id text not null,
  primary key (channel, external_id)
);
create index channel_identities_user on channel_identities (user_id);

-- The one continuous conversation.
create table messages (
  id bigserial primary key,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('user', 'emi')),
  content text not null,
  kind text not null default 'reply' check (kind in ('reply', 'proactive')),
  agenda_item_id uuid,
  created_at timestamptz not null
);
create index messages_user on messages (user_id, id);

-- Durable memory. Events are things that happened and are never retired as
-- outdated; the other kinds are states and may be replaced by a newer one,
-- with the old row kept and linked.
create table memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null
    check (kind in ('identity', 'boundary', 'relationship', 'preference', 'state', 'event')),
  content text not null,
  status text not null default 'active'
    check (status in ('active', 'superseded', 'deleted')),
  pinned boolean not null default false,
  -- 'stated': extracted with an exact quote. 'user': written or edited by the
  -- person, and never rewritten by a model.
  source text not null default 'stated' check (source in ('stated', 'user')),
  evidence text not null default '',
  source_message_id bigint,
  -- The person's own calendar day the event happened on.
  occurred_on date,
  storyline text,
  superseded_by uuid references memories (id),
  -- Refreshed only when the memory is recalled on its own relevance, never
  -- because it holds a standing slot.
  last_relevant_at timestamptz,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index memories_user_status on memories (user_id, status);
create index memories_tsv on memories using gin (tsv);
create index memories_embedding on memories using hnsw (embedding vector_cosine_ops);

-- Things Emi means to bring up.
--   reminder   the person asked to be told at a time. Sent at that time.
--   followup   something in their future she wants to ask about afterwards.
--   initiative her own reason to write, planned at most once a day.
-- A null ping_at means "only if they are already talking to me".
create table agenda_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'followup', 'initiative')),
  about text not null,
  reason text not null default '',
  importance smallint not null default 1 check (importance between 1 and 3),
  event_at timestamptz,
  window_start timestamptz not null,
  window_end timestamptz not null,
  ping_at timestamptz,
  closes_when text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'woven', 'pinged', 'done', 'cancelled', 'expired')),
  attempts integer not null default 0,
  dedupe_key text not null,
  source_message_id bigint,
  resolution_note text not null default '',
  pinged_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index agenda_one_pending on agenda_items (user_id, dedupe_key)
  where status = 'pending';
create index agenda_due on agenda_items (ping_at)
  where status = 'pending' and ping_at is not null;
create index agenda_user_status on agenda_items (user_id, status);

create table usage_events (
  id bigserial primary key,
  user_id uuid not null references users (id) on delete cascade,
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null
);
create index usage_user_time on usage_events (user_id, created_at);
