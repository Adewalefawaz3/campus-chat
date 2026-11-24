# Campus Chat

Browser-first group chat for classes and communities. One Cloudflare Worker serves the website, the API and live WebSockets. **PostgreSQL is the only place data lives.**

```
.github/workflows/deploy.yml   push to main -> check -> migrate database -> deploy to Cloudflare
db/migrations/0001_init.sql    all tables (users, rooms, matric rules, invites, messages, polls, files, audit log...)
scripts/migrate.mjs            safe migration runner
worker/src/index.ts            API (auth, rooms, join, messages, settings)
worker/src/room.ts             live broadcast (stores nothing)
web/                           frontend (light theme default, a few KB of JS)
wrangler.toml                  Cloudflare config
```

## One-time setup (about 15 minutes)

### 1. Database (Supabase, already created)
Project `campus-chat` (London) already exists and the tables are already in it. In Supabase, click **Connect** and copy the **Session pooler** connection string (port 5432). Replace `[YOUR-PASSWORD]` with your database password (Project Settings > Database > Reset password if you don't have it).
Use the *session pooler*, not the "direct" one: GitHub's servers and Cloudflare can't reach the direct address, and the session pooler keeps migrations safe.

### 2. Put the code on GitHub
Unzip, then in the folder:
```
git init -b main
git add -A
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-NAME/campus-chat.git
git push -u origin main
```
Uploading through the GitHub website instead? Hidden folders are easy to miss. Make sure `.github/workflows/deploy.yml` arrived; if not, use *Add file > Create new file*, type `.github/workflows/deploy.yml` as the name, and paste the file contents.

### 3. Cloudflare database link (already done)
Hyperdrive config `campus-chat-db` exists and its ID is already in `wrangler.toml`. It uses a limited database login named `hyperdrive_user`, so the live app never holds your main database password.

### 4. Add three GitHub secrets
GitHub repo > Settings > Secrets and variables > Actions > New repository secret:

| Name | Where to get it |
|---|---|
| `DATABASE_URL` | the Session pooler string from step 1 (uses your main database password; only the deploy job sees it) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard > My Profile > API Tokens > Create Token > template **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | `22ee889b7006353cd8ad35f202636bcc` |

### 5. Deploy
Push to `main` (or Actions tab > re-run). When it finishes, your site is at
`https://campus-chat.<your-subdomain>.workers.dev`. Add your own domain in Cloudflare > Workers > campus-chat > Settings > Domains.

## How updates never lose data
- Your code and your data are separate. Deploying new code does not touch Postgres.
- Every deploy runs `scripts/migrate.mjs` first. It applies only migration files it has not run before.
- **To change the database, add a new file** such as `db/migrations/0002_add_reactions_index.sql`. Never edit an old one (the runner refuses if you do).
- Prefer additive changes: `create table`, `add column` (nullable or with a default), `create index`. The runner also blocks `drop table` and `truncate` unless you add `-- allow-destructive` on purpose.
- Turn on backups / point-in-time recovery in your Postgres host (Neon and Supabase both offer it).

## Saved means saved
- A message is written to Postgres first. Only after that succeeds does the Worker broadcast it.
- The browser shows "Sending..." until the server confirms, then "Not sent / Try again" on failure. Retries reuse the same `clientId`, so a flaky connection can never create duplicates.
- Dropped WebSocket? The page reconnects and fetches anything it missed from Postgres.

## Local development
```
# terminal 1 (needs a local Postgres; edit localConnectionString in wrangler.toml)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/campus_chat npm run migrate
npm run dev:api
# terminal 2
npm run dev
```

## What's built vs next
Built: accounts, shared-device sessions (20 min idle, 4 h max, sign out of other devices), departmental and general rooms, matric range / allow / block rules, invite codes with rotation, live chat, admins-only mode, slow mode, audit log, rate limiting.
Tables exist but have **no screens yet**: polls, reactions, files and the Files Vault, bans, co-admin promotion. Add each as a new API route plus UI; no schema change needed.
