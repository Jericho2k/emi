-- Images are viewed in full once, then described in text for later turns.
-- A picture that is sent again or replied to points at the stored copy
-- instead of holding a second copy of the same bytes.
alter table message_images
  -- Channel file identity (e.g. "telegram:<file_unique_id>"). Never a download URL.
  add column source_key text,
  -- Written once from the pixels and used in place of them on later turns.
  add column description text check (char_length(description) <= 8000),
  add column describe_attempts smallint not null default 0,
  add column describing_at timestamptz,
  -- Set on a row that reuses another row's bytes; such a row holds no bytes.
  add column source_image_id uuid references message_images (id) on delete cascade,
  alter column data drop not null,
  add constraint message_images_bytes_or_source check ((data is null) <> (source_image_id is null));

create index message_images_source_key on message_images (source_key) where source_key is not null;
create index message_images_source_image on message_images (source_image_id) where source_image_id is not null;
create index message_images_undescribed on message_images (message_id) where description is null and data is not null;
