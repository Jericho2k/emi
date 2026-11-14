-- The relationship layer.
--
-- bond: warmth, trust and irritation, nudged by the extractor after each
-- exchange and bounded in code. Closeness itself is never stored: it is
-- derived from how long and how often they have actually talked.
alter table users add column bond jsonb not null default '{}';
-- What has been on Emi's mind, one short line per local day, newest last.
alter table users add column inner_days jsonb not null default '[]';
-- When she last planned a message with no reason but that she thought of them.
alter table users add column last_spontaneous_at timestamptz;

-- self: what Emi said about herself (opinions, tastes, promises).
-- us:   what belongs to the two of them (nicknames, running jokes, moments).
alter table memories drop constraint memories_kind_check;
alter table memories add constraint memories_kind_check
  check (kind in ('identity', 'boundary', 'relationship', 'preference', 'state', 'event', 'self', 'us'));

alter table agenda_items add column spontaneous boolean not null default false;
