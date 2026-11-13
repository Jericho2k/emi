-- Long history. The recent messages are sent to the writer in full; everything
-- older is kept as a permanent timeline that is written once and never
-- re-summarised.

-- Highest message id that has been written into an arc.
alter table users add column consolidated_through bigint not null default 0;

-- One stretch of conversation that left the writer's view: a chapter summary
-- and a one-line headline, for exactly the messages it covers.
create table arcs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  start_message_id bigint not null,
  end_message_id bigint not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  headline text not null,
  summary text not null,
  embedding vector(1024),
  created_at timestamptz not null
);
create index arcs_user on arcs (user_id, end_message_id);

-- Arcs folded once into a chapter (level 1), chapters folded once into a part
-- (level 2), and so on. Nothing folded is summarised again, so the order of
-- events cannot drift and the timeline grows only logarithmically.
create table timeline_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  level smallint not null,
  start_message_id bigint not null,
  end_message_id bigint not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  summary text not null,
  created_at timestamptz not null
);
create index timeline_user on timeline_entries (user_id, level, end_message_id);

-- When an item was last put in front of the writer as something to bring up.
-- Offered once per conversation, so an ignored question is not asked again
-- on every following turn.
alter table agenda_items add column offered_at timestamptz;
