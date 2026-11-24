-- 0002_enable_rls: Supabase exposes the public schema through a public REST API.
-- Turning on Row Level Security with NO policies blocks that API completely.
-- The Worker connects as the database owner, which is not affected by RLS, so the app keeps working.
alter table users enable row level security;
alter table user_identities enable row level security;
alter table sessions enable row level security;
alter table rooms enable row level security;
alter table room_matric_rules enable row level security;
alter table room_invites enable row level security;
alter table room_members enable row level security;
alter table room_bans enable row level security;
alter table messages enable row level security;
alter table reactions enable row level security;
alter table files enable row level security;
alter table polls enable row level security;
alter table poll_options enable row level security;
alter table poll_votes enable row level security;
alter table audit_log enable row level security;
alter table join_attempts enable row level security;
