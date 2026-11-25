// Safe, additive SQL migrations.
//  - Runs every db/migrations/*.sql file once, in filename order, each inside a transaction.
//  - Records applied files in the _migrations table, so re-running does nothing.
//  - Refuses to run if an already-applied file was edited (add a NEW file instead).
//  - Refuses DROP TABLE / DROP DATABASE / TRUNCATE unless the file contains "-- allow-destructive".
//  - Uses a Postgres advisory lock so two deploys can never migrate at the same time.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const dir = path.resolve("db/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`select pg_advisory_lock(727274)`;
  await sql`create table if not exists _migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`;
  await sql`alter table _migrations enable row level security`;
  const applied = new Map((await sql`select name, checksum from _migrations`).map((r) => [r.name, r.checksum]));

  let ran = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const sum = crypto.createHash("sha256").update(text).digest("hex");

    if (applied.has(file)) {
      if (applied.get(file) !== sum) {
        throw new Error(`Migration ${file} was edited after it was applied. Leave it alone and add a new migration file instead.`);
      }
      continue;
    }
    if (/\b(drop\s+table|drop\s+database|truncate)\b/i.test(text) && !text.includes("-- allow-destructive")) {
      throw new Error(`Migration ${file} would delete data. If that is really intended, add the line "-- allow-destructive" to the file.`);
    }

    console.log(`Applying ${file} ...`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into _migrations (name, checksum) values (${file}, ${sum})`;
    });
    ran++;
  }
  console.log(ran ? `Done: ${ran} migration(s) applied.` : "Database is already up to date.");
} catch (err) {
  console.error(err.message || err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
