-- 0003_voice_notes: voice notes (stored in Postgres, 60 s max) + poll indexes.
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check check (kind in ('text','announcement','system','voice'));

create table voice_notes (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null unique references messages(id),
  room_id uuid not null references rooms(id),
  user_id uuid not null references users(id),
  mime text not null,
  duration_ms int not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index voice_notes_room_idx on voice_notes (room_id);
alter table voice_notes enable row level security;

create index polls_room_idx on polls (room_id, created_at desc);
create index poll_options_poll_idx on poll_options (poll_id);
