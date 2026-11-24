import postgres from "postgres";
export { Room } from "./room";

type Env = { HYPERDRIVE: Hyperdrive; ROOM: DurableObjectNamespace; ASSETS: Fetcher };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const normMatric = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normCode = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function pbkdf2(pw: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as any, iterations }, key, 256));
}
async function hashPassword(pw: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${b64(await pbkdf2(pw, salt, 100000))}`;
}
async function verifyPassword(pw: string, stored: string) {
  const [, it, salt, hash] = stored.split("$");
  return safeEq(b64(await pbkdf2(pw, unb64(salt), +it)), hash);
}
function newCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/* ---------- auth / sessions ---------- */
async function createSession(sql: any, userId: string, shared: boolean) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await sql`insert into sessions (user_id, token_hash, shared_device, idle_timeout_s, expires_at)
    values (${userId}, ${await sha256(token)}, ${shared}, ${shared ? 1200 : null}::int,
            now() + make_interval(secs => ${shared ? 14400 : 2592000}::int))`;
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${shared ? "" : "; Max-Age=2592000"}`;
}
function readToken(req: Request) {
  return /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.get("cookie") ?? "")?.[1];
}
async function auth(sql: any, req: Request) {
  const token = readToken(req);
  if (!token) throw new HttpError(401, "Please sign in.");
  const [row] = await sql`
    update sessions s set last_seen_at = now()
    from users u
    where s.token_hash = ${await sha256(token)} and u.id = s.user_id
      and s.revoked_at is null and s.expires_at > now()
      and (s.idle_timeout_s is null or s.last_seen_at + make_interval(secs => s.idle_timeout_s) > now())
    returning u.id, u.display_name, u.email, s.id as session_id, s.shared_device`;
  if (!row) throw new HttpError(401, "Your session ended. Please sign in again.");
  return row;
}
async function rateLimit(sql: any, ip: string) {
  const [r] = await sql`select count(*)::int as n from join_attempts
    where ip = ${ip} and result <> 'ok' and created_at > now() - interval '10 minutes'`;
  if (r.n >= 15) throw new HttpError(429, "Too many failed attempts. Wait 10 minutes and try again.");
}
const logAttempt = (sql: any, ip: string, userId: string | null, code: string | null, matric: string | null, result: string) =>
  sql`insert into join_attempts (ip, user_id, code, matric_norm, result) values (${ip}, ${userId}, ${code}, ${matric}, ${result})`;

/* ---------- rooms ---------- */
async function membership(sql: any, roomId: string, userId: string) {
  if (!isUuid(roomId)) throw new HttpError(404, "Room not found.");
  const [m] = await sql`select m.role, r.name, r.kind, r.chat_mode, r.slow_mode_s, r.join_mode, r.school
    from room_members m join rooms r on r.id = m.room_id
    where m.room_id = ${roomId} and m.user_id = ${userId} and m.status = 'active' and r.deleted_at is null`;
  if (!m) throw new HttpError(404, "Room not found.");
  return m;
}
const isAdmin = (role: string) => role === "creator" || role === "co_admin";

function matricAllowed(norm: string, rules: any[]) {
  if (rules.some((r) => r.kind === "block" && r.prefix === norm)) return false;
  if (rules.some((r) => r.kind === "allow" && r.prefix === norm)) return true;
  return rules.some((r) => {
    if (r.kind !== "range" || !norm.startsWith(r.prefix)) return false;
    const rest = norm.slice(r.prefix.length);
    if (!/^\d+$/.test(rest)) return false;
    if (r.num_width != null && rest.length !== r.num_width) return false;
    const n = +rest;
    return n >= r.num_start && n <= r.num_end;
  });
}

// Tell connected clients about something that is ALREADY saved in PostgreSQL.
async function broadcast(env: Env, roomId: string, event: unknown) {
  try {
    await env.ROOM.get(env.ROOM.idFromName(roomId)).fetch("https://room/broadcast", {
      method: "POST",
      body: JSON.stringify(event),
    });
  } catch (e) {
    // The data is safe in PostgreSQL; clients catch up when they reconnect.
    console.error("broadcast failed", e);
  }
}

/* ---------- request handling ---------- */
async function handle(req: Request, env: Env, sql: any): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const body = async () => {
    try {
      return (await req.json()) as any;
    } catch {
      throw new HttpError(400, "Invalid request.");
    }
  };

  /* --- auth --- */
  if (m === "POST" && p === "/api/auth/signup") {
    const b = await body();
    const email = str(b.email, 200).toLowerCase();
    const name = str(b.displayName, 60);
    const pw = String(b.password ?? "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (name.length < 2) throw new HttpError(400, "Enter your name (at least 2 characters).");
    if (pw.length < 8) throw new HttpError(400, "Use a password of at least 8 characters.");
    const school = str(b.school, 120);
    const matric = normMatric(b.matric);
    try {
      const user = await sql.begin(async (tx: any) => {
        const [u] = await tx`insert into users (email, display_name, password_hash)
          values (${email}, ${name}, ${await hashPassword(pw)}) returning id, display_name, email`;
        if (school && matric)
          await tx`insert into user_identities (user_id, school, matric_raw, matric_norm)
            values (${u.id}, ${school}, ${str(b.matric, 40)}, ${matric})`;
        return u;
      });
      const cookie = await createSession(sql, user.id, !!b.shared);
      return json({ user }, 201, { "set-cookie": cookie });
    } catch (e: any) {
      if (e?.code === "23505") throw new HttpError(409, "That email or matric number already has an account. Try signing in.");
      throw e;
    }
  }

  if (m === "POST" && p === "/api/auth/login") {
    const b = await body();
    await rateLimit(sql, ip);
    const [u] = await sql`select id, display_name, email, password_hash from users where lower(email) = ${str(b.email, 200).toLowerCase()}`;
    if (!u || !(await verifyPassword(String(b.password ?? ""), u.password_hash))) {
      await logAttempt(sql, ip, null, "login", null, "bad_login");
      throw new HttpError(401, "Wrong email or password.");
    }
    const cookie = await createSession(sql, u.id, !!b.shared);
    return json({ user: { id: u.id, display_name: u.display_name, email: u.email } }, 200, { "set-cookie": cookie });
  }

  if (m === "POST" && p === "/api/auth/logout") {
    const token = readToken(req);
    if (token) await sql`update sessions set revoked_at = now() where token_hash = ${await sha256(token)}`;
    return json({ ok: true }, 200, { "set-cookie": "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
  }

  /* --- invite preview (safe GET: never joins anyone) --- */
  let mt = /^\/api\/invite\/([A-Za-z0-9-]+)$/.exec(p);
  if (m === "GET" && mt) {
    const [r] = await sql`select r.name, r.kind, r.join_mode, r.school, r.department, r.level
      from room_invites i join rooms r on r.id = i.room_id
      where i.code = ${normCode(mt[1])} and i.revoked_at is null and r.deleted_at is null
        and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses)`;
    if (!r) throw new HttpError(404, "This invite link is no longer valid.");
    return json({ room: r });
  }

  /* --- everything below needs a signed-in user --- */
  const user = await auth(sql, req);

  if (m === "POST" && p === "/api/auth/logout-all") {
    await sql`update sessions set revoked_at = now() where user_id = ${user.id} and id <> ${user.session_id} and revoked_at is null`;
    return json({ ok: true });
  }

  if (m === "GET" && p === "/api/me") {
    const rooms = await sql`select r.id, r.name, r.kind, m.role from room_members m
      join rooms r on r.id = m.room_id
      where m.user_id = ${user.id} and m.status = 'active' and r.deleted_at is null order by r.created_at`;
    return json({ user: { id: user.id, display_name: user.display_name, email: user.email, shared: user.shared_device }, rooms });
  }

  if (m === "POST" && p === "/api/rooms") {
    const b = await body();
    const kind = b.kind === "departmental" ? "departmental" : "general";
    const name = str(b.name, 80);
    if (name.length < 2) throw new HttpError(400, "Give the room a name.");
    const joinMode = kind === "departmental" && b.joinMode === "matric_locked" ? "matric_locked" : "code_only";
    const privacy = b.privacy === "public" ? "public" : "secret";
    const rules: any[] = [];
    if (joinMode === "matric_locked") {
      const mx = b.matric ?? {};
      const prefix = normMatric(mx.prefix);
      const start = parseInt(mx.start, 10), end = parseInt(mx.end, 10), width = parseInt(mx.width, 10);
      if (!prefix || !(start >= 0) || !(end >= start)) throw new HttpError(400, "Enter the matric prefix and a valid number range, e.g. 22/66MG and 1 to 250.");
      rules.push({ kind: "range", prefix, start, end, width: width > 0 ? width : null });
      for (const a of String(mx.allow ?? "").split(/[,\n]/)) if (normMatric(a)) rules.push({ kind: "allow", prefix: normMatric(a) });
      for (const x of String(mx.block ?? "").split(/[,\n]/)) if (normMatric(x)) rules.push({ kind: "block", prefix: normMatric(x) });
    }
    const out = await sql.begin(async (tx: any) => {
      const [room] = await tx`insert into rooms (kind, name, school, department, level, privacy, join_mode, creator_id)
        values (${kind}, ${name}, ${str(b.school, 120) || null}, ${str(b.department, 120) || null}, ${str(b.level, 20) || null},
                ${privacy}, ${joinMode}, ${user.id}) returning id, name, kind`;
      await tx`insert into room_members (room_id, user_id, role) values (${room.id}, ${user.id}, 'creator')`;
      for (const r of rules)
        await tx`insert into room_matric_rules (room_id, kind, prefix, num_start, num_end, num_width)
          values (${room.id}, ${r.kind}, ${r.prefix}, ${r.start ?? null}, ${r.end ?? null}, ${r.width ?? null})`;
      const code = newCode();
      await tx`insert into room_invites (room_id, code, created_by) values (${room.id}, ${code}, ${user.id})`;
      await tx`insert into audit_log (room_id, actor_id, action, target_type, target_id, meta)
        values (${room.id}, ${user.id}, 'room.create', 'room', ${room.id}, ${JSON.stringify({ kind, joinMode })}::jsonb)`;
      return { room, code };
    });
    return json(out, 201);
  }

  if (m === "POST" && p === "/api/join") {
    const b = await body();
    await rateLimit(sql, ip);
    const code = normCode(b.code);
    const [inv] = await sql`select i.id as invite_id, r.id as room_id, r.name, r.join_mode, r.school
      from room_invites i join rooms r on r.id = i.room_id
      where i.code = ${code} and i.revoked_at is null and r.deleted_at is null
        and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses)`;
    if (!inv) {
      await logAttempt(sql, ip, user.id, code, null, "bad_code");
      throw new HttpError(404, "That code is invalid or has expired. Ask an admin for a fresh link.");
    }
    const [existing] = await sql`select status from room_members where room_id = ${inv.room_id} and user_id = ${user.id}`;
    if (existing?.status === "active") return json({ roomId: inv.room_id });
    if (existing && existing.status !== "pending") throw new HttpError(403, "You can't join this room.");

    let identityId: string | null = null;
    let norm: string | null = null;
    if (inv.join_mode === "matric_locked") {
      norm = normMatric(b.matric);
      if (!norm) throw new HttpError(400, "This room needs your matric number.");
      const rules = await sql`select kind, prefix, num_start, num_end, num_width from room_matric_rules where room_id = ${inv.room_id}`;
      const [banned] = await sql`select 1 from room_bans where room_id = ${inv.room_id} and (user_id = ${user.id} or matric_norm = ${norm})`;
      if (banned || !matricAllowed(norm, rules)) {
        await logAttempt(sql, ip, user.id, code, norm, "matric_rejected");
        throw new HttpError(403, "That matric number isn't on this room's list. Check it and try again.");
      }
    } else {
      const [banned] = await sql`select 1 from room_bans where room_id = ${inv.room_id} and user_id = ${user.id}`;
      if (banned) throw new HttpError(403, "You can't join this room.");
    }
    try {
      await sql.begin(async (tx: any) => {
        if (norm) {
          const [mine] = await tx`select id, matric_norm from user_identities where user_id = ${user.id} and school = ${inv.school ?? ""}`;
          if (mine) {
            if (mine.matric_norm !== norm) throw new HttpError(403, "Your account is registered with a different matric number.");
            identityId = mine.id;
          } else {
            const [created] = await tx`insert into user_identities (user_id, school, matric_raw, matric_norm)
              values (${user.id}, ${inv.school ?? ""}, ${str(b.matric, 40)}, ${norm}) returning id`;
            identityId = created.id;
          }
        }
        await tx`insert into room_members (room_id, user_id, role, identity_id) values (${inv.room_id}, ${user.id}, 'member', ${identityId})
          on conflict (room_id, user_id) do update set status = 'active', identity_id = excluded.identity_id`;
        await tx`update room_invites set uses = uses + 1 where id = ${inv.invite_id}`;
        await tx`insert into audit_log (room_id, actor_id, action, target_type, target_id)
          values (${inv.room_id}, ${user.id}, 'member.join', 'user', ${user.id})`;
      });
    } catch (e: any) {
      if (e?.code === "23505") throw new HttpError(409, "That matric number has already been claimed by another account. Ask an admin for help.");
      throw e;
    }
    await logAttempt(sql, ip, user.id, code, norm, "ok");
    return json({ roomId: inv.room_id });
  }

  /* --- room routes --- */
  mt = /^\/api\/rooms\/([0-9a-f-]{36})(\/.*)?$/i.exec(p);
  if (mt) {
    const roomId = mt[1];
    const sub = mt[2] ?? "";
    const mem = await membership(sql, roomId, user.id);

    if (m === "GET" && sub === "") {
      let code: string | null = null;
      if (isAdmin(mem.role)) {
        const [i] = await sql`select code from room_invites where room_id = ${roomId} and revoked_at is null order by created_at desc limit 1`;
        code = i?.code ?? null;
      }
      return json({ room: { id: roomId, name: mem.name, kind: mem.kind, chat_mode: mem.chat_mode, slow_mode_s: mem.slow_mode_s }, role: mem.role, code });
    }

    if (m === "GET" && sub === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "WebSocket required.");
      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(req);
    }

    if (m === "GET" && sub === "/messages") {
      const after = parseInt(url.searchParams.get("after") ?? "", 10);
      const before = parseInt(url.searchParams.get("before") ?? "", 10);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
      let rows: any[];
      if (after >= 0) {
        rows = await sql`select m.id, m.client_id, m.user_id, m.body, m.created_at, u.display_name
          from messages m join users u on u.id = m.user_id
          where m.room_id = ${roomId} and m.deleted_at is null and m.id > ${after}
          order by m.id asc limit ${limit}`;
      } else {
        rows = await sql`select m.id, m.client_id, m.user_id, m.body, m.created_at, u.display_name
          from messages m join users u on u.id = m.user_id
          where m.room_id = ${roomId} and m.deleted_at is null and (${before >= 0 ? before : null}::bigint is null or m.id < ${before >= 0 ? before : null}::bigint)
          order by m.id desc limit ${limit}`;
        rows.reverse();
      }
      return json({ messages: rows });
    }

    if (m === "POST" && sub === "/messages") {
      const b = await body();
      const text = str(b.body, 2000);
      if (!text) throw new HttpError(400, "Write a message first.");
      if (!isUuid(String(b.clientId ?? ""))) throw new HttpError(400, "Invalid message id.");
      if (mem.chat_mode === "admins_only" && !isAdmin(mem.role)) throw new HttpError(403, "Only admins can post right now.");
      if (mem.slow_mode_s > 0 && !isAdmin(mem.role)) {
        const [last] = await sql`select extract(epoch from now() - max(created_at))::int as ago from messages where room_id = ${roomId} and user_id = ${user.id}`;
        if (last?.ago != null && last.ago < mem.slow_mode_s)
          throw new HttpError(429, `Slow mode is on. Wait ${mem.slow_mode_s - last.ago}s before sending again.`);
      }
      // 1) SAVE to PostgreSQL. If this throws, nothing is broadcast and the client sees an error.
      let [saved] = await sql`with ins as (
          insert into messages (room_id, user_id, client_id, body) values (${roomId}, ${user.id}, ${b.clientId}, ${text})
          on conflict (room_id, user_id, client_id) do nothing returning *)
        select ins.id, ins.client_id, ins.user_id, ins.body, ins.created_at, ${user.display_name}::text as display_name from ins`;
      if (saved) {
        // 2) ONLY NOW tell everyone else.
        await broadcast(env, roomId, { type: "message", message: saved });
        return json({ message: saved }, 201);
      }
      // Same clientId retried: return the stored copy, don't duplicate.
      [saved] = await sql`select m.id, m.client_id, m.user_id, m.body, m.created_at, u.display_name from messages m
        join users u on u.id = m.user_id where m.room_id = ${roomId} and m.user_id = ${user.id} and m.client_id = ${b.clientId}`;
      return json({ message: saved }, 200);
    }

    if (m === "POST" && sub === "/invite/rotate") {
      if (!isAdmin(mem.role)) throw new HttpError(403, "Only admins can do that.");
      const code = newCode();
      await sql.begin(async (tx: any) => {
        await tx`update room_invites set revoked_at = now() where room_id = ${roomId} and revoked_at is null`;
        await tx`insert into room_invites (room_id, code, created_by) values (${roomId}, ${code}, ${user.id})`;
        await tx`insert into audit_log (room_id, actor_id, action) values (${roomId}, ${user.id}, 'invite.rotate')`;
      });
      return json({ code });
    }

    if (m === "POST" && sub === "/settings") {
      if (!isAdmin(mem.role)) throw new HttpError(403, "Only admins can do that.");
      const b = await body();
      const chatMode = b.chatMode === "admins_only" ? "admins_only" : "open";
      const slow = Math.min(Math.max(parseInt(b.slowModeS, 10) || 0, 0), 600);
      await sql.begin(async (tx: any) => {
        await tx`update rooms set chat_mode = ${chatMode}, slow_mode_s = ${slow} where id = ${roomId}`;
        await tx`insert into audit_log (room_id, actor_id, action, meta)
          values (${roomId}, ${user.id}, 'room.settings', ${JSON.stringify({ chatMode, slow })}::jsonb)`;
      });
      await broadcast(env, roomId, { type: "room", chat_mode: chatMode, slow_mode_s: slow });
      return json({ chat_mode: chatMode, slow_mode_s: slow });
    }
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    try {
      return await handle(req, env, sql);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("API error", e);
      return json({ error: "Something went wrong on our side. Nothing was lost. Please try again." }, 500);
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
