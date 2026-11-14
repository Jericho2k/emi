-- Stickers, voice notes and mischief.
--
-- mischief: whether she may do playful things beyond words when she is in a
-- mood (for now, pinning a sulky status in the chat). On by default; the
-- person turns it off with /mischief off.
alter table users add column mischief boolean not null default true;

-- Every playful change she makes, with what it takes to undo it. She undoes
-- each one herself once she has cooled down, so nothing she does sticks.
create table mischief_acts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null,
  undone_at timestamptz
);
create index mischief_active on mischief_acts (user_id) where undone_at is null;
