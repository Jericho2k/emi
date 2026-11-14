-- Private image bytes are separate from text history and can later be moved
-- behind the same storage interface. Deleting a message erases its images.
create table message_images (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references messages (id) on delete cascade,
  position smallint not null check (position between 0 and 5),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  origin text check (origin = 'reply'),
  data bytea not null check (octet_length(data) between 12 and 8388608),
  unique (message_id, position)
);
-- Direct backend connections use the table owner. The Supabase public Data
-- API must not expose image bytes via an anonymous or authenticated role.
alter table message_images enable row level security;
