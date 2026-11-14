-- Integrations: Google Calendar and Tasks, Spotify.
--
-- autonomy: how much she does without asking.
--   ask     every change waits for their OK
--   normal  adding things just happens; moving or removing waits for their OK
--   auto    she just does it
alter table users add column autonomy text not null default 'normal'
  check (autonomy in ('ask', 'normal', 'auto'));

-- One row per connected account. Tokens are encrypted with EMI_MASTER_KEY,
-- like API keys, and never leave the server.
create table connections (
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('google', 'spotify')),
  encrypted_refresh_token text not null,
  encrypted_access_token text,
  access_expires_at timestamptz,
  scopes text not null default '',
  connected_at timestamptz not null,
  primary key (user_id, provider)
);

-- Changes she proposed that wait for their OK, behind a Telegram button.
create table pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  action jsonb not null,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'declined', 'failed', 'expired')),
  created_at timestamptz not null,
  decided_at timestamptz
);
create index pending_actions_user on pending_actions (user_id, status);
