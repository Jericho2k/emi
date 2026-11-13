-- Keep transport context separate from the person's own words. Existing rows
-- remain valid; no history is rewritten.
alter table messages add column reply_context jsonb;
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('reply', 'proactive', 'command'));
