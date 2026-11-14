-- A wipe invalidates work already running in this conversation, on any worker.
alter table users add column conversation_version bigint not null default 0;
