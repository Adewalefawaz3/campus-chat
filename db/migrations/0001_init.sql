-- 0001_init: core tables. Never edit this file after it has been deployed; add 0002_..., 0003_... instead.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));

-- A matric number belongs to a person per school (one account per matric).
create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  school text not null,
  matric_raw text not null,
  matric_norm text not null,
  created_at timestamptz not null default now(),
  unique (school, matric_norm),
  unique (user_id, school)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  shared_device boolean not null default false,
  idle_timeout_s int,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions (user_id);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('departmental','general')),
  name text not null,
  school text,
  department text,
  level text,
  session_year text,
  privacy text not null default 'secret' check (privacy in ('public','secret')),
  join_mode text not null default 'code_only' check (join_mode in ('matric_locked','code_only','open')),
  chat_mode text not null default 'open' check (chat_mode in ('open','admins_only')),
  slow_mode_s int not null default 0,
  creator_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz
);

-- kind=range: prefix + numeric range.  kind=allow/block: prefix holds one full normalized matric.
create table room_matric_rules (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  kind text not null check (kind in ('range','allow','block')),
  prefix text not null,
  num_start int,
  num_end int,
  num_width int,
  note text
);
create index room_matric_rules_room_idx on room_matric_rules (room_id);

create table room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  code text not null unique,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses int,
  uses int not null default 0,
  revoked_at timestamptz
);
create index room_invites_room_idx on room_invites (room_id);

create table room_members (
  room_id uuid not null references rooms(id),
  user_id uuid not null references users(id),
  role text not null default 'member' check (role in ('creator','co_admin','member')),
  status text not null default 'active' check (status in ('active','pending','kicked','banned')),
  identity_id uuid references user_identities(id),
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create unique index room_members_identity_uq on room_members (room_id, identity_id)
  where status = 'active' and identity_id is not null;
create index room_members_user_idx on room_members (user_id);

create table room_bans (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  user_id uuid references users(id),
  matric_norm text,
  reason text,
  by_user uuid references users(id),
  created_at timestamptz not null default now()
);
create index room_bans_room_idx on room_bans (room_id);

-- client_id makes retries safe: sending the same message twice stores it once.
create table messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references rooms(id),
  user_id uuid not null references users(id),
  client_id uuid not null,
  kind text not null default 'text' check (kind in ('text','announcement','system')),
  body text not null,
  reply_to bigint references messages(id),
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  unique (room_id, user_id, client_id)
);
create index messages_room_idx on messages (room_id, id desc);

create table reactions (
  message_id bigint not null references messages(id),
  user_id uuid not null references users(id),
  emoji text not null,
  primary key (message_id, user_id, emoji)
);

create table files (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  uploader_id uuid not null references users(id),
  message_id bigint references messages(id),
  title text not null,
  original_name text not null,
  storage_key text not null,
  mime text,
  size bigint,
  category text not null default 'other' check (category in ('handout','timetable','past_question','other')),
  course_code text,
  download_count int not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index files_room_course_idx on files (room_id, course_code);

create table polls (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  created_by uuid not null references users(id),
  question text not null,
  closes_at timestamptz,
  created_at timestamptz not null default now()
);
create table poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id),
  label text not null,
  position int not null default 0
);
create table poll_votes (
  poll_id uuid not null references polls(id),
  user_id uuid not null references users(id),
  option_id uuid not null references poll_options(id),
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

create table audit_log (
  id bigint generated always as identity primary key,
  room_id uuid references rooms(id),
  actor_id uuid references users(id),
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_room_idx on audit_log (room_id, id desc);

-- Used for rate limiting (logins and join attempts).
create table join_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  user_id uuid,
  code text,
  matric_norm text,
  result text not null,
  created_at timestamptz not null default now()
);
create index join_attempts_ip_idx on join_attempts (ip, created_at desc);
