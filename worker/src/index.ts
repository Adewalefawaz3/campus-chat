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
    with cur as (
      select u.id, u.display_name, u.email, s.id as session_id, s.shared_device
      from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${await sha256(token)} and s.revoked_at is null and s.expires_at > now()
        and (s.idle_timeout_s is null or s.last_seen_at + make_interval(secs => s.idle_timeout_s) > now())
    ), touch as (
      update sessions set last_seen_at = now()
      where id = (select session_id from cur) and last_seen_at < now() - interval '60 seconds'
    )
    select * from cur`;
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
async function handle(req: Request, env: Env, sql: any, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  // Always called AFTER the database write succeeded; never delays the reply.
  const bcast = (roomId: string, ev: unknown) => ctx.waitUntil(broadcast(env, roomId, ev));
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
    const rooms = await sql`select r.id, r.name, r.kind, m.role,
        (select count(*)::int from room_members x where x.room_id = r.id and x.status = 'active') as members,
        lm.body as last_body, lm.kind as last_kind, lm.created_at as last_at, lu.display_name as last_by
      from room_members m join rooms r on r.id = m.room_id
      left join lateral (select body, kind, created_at, user_id from messages
        where room_id = r.id and deleted_at is null order by id desc limit 1) lm on true
      left join users lu on lu.id = lm.user_id
      where m.user_id = ${user.id} and m.status = 'active' and r.deleted_at is null
      order by coalesce(lm.created_at, r.created_at) desc`;
    return json({ user: { id: user.id, display_name: user.display_name, email: user.email, shared: user.shared_device }, rooms });
  }

  if (m === "GET" && p === "/api/profile") {
    const identities = await sql`select school, matric_raw from user_identities where user_id = ${user.id} order by created_at`;
    return json({ user: { id: user.id, display_name: user.display_name, email: user.email }, identities });
  }

  if (m === "POST" && p === "/api/profile") {
    const b = await body();
    const name = str(b.displayName, 60);
    if (name.length < 2) throw new HttpError(400, "Enter your name (at least 2 characters).");
    const school = str(b.school, 120);
    const matric = normMatric(b.matric);
    if (school && matric) {
      const [mine] = await sql`select matric_norm from user_identities where user_id = ${user.id} and school = ${school}`;
      if (mine && mine.matric_norm !== matric) throw new HttpError(403, "A saved matric number can't be changed here. Ask a room admin for help.");
      if (!mine) {
        try {
          await sql`insert into user_identities (user_id, school, matric_raw, matric_norm) values (${user.id}, ${school}, ${str(b.matric, 40)}, ${matric})`;
        } catch (e: any) {
          if (e?.code === "23505") throw new HttpError(409, "That matric number is already claimed by another account.");
          throw e;
        }
      }
    }
    await sql`update users set display_name = ${name} where id = ${user.id}`;
    return json({ ok: true });
  }

  if (m === "POST" && p === "/api/profile/password") {
    const b = await body();
    const [u] = await sql`select password_hash from users where id = ${user.id}`;
    if (!(await verifyPassword(String(b.current ?? ""), u.password_hash))) throw new HttpError(403, "Your current password is wrong.");
    const next = String(b.next ?? "");
    if (next.length < 8) throw new HttpError(400, "Use a new password of at least 8 characters.");
    await sql`update users set password_hash = ${await hashPassword(next)} where id = ${user.id}`;
    await sql`update sessions set revoked_at = now() where user_id = ${user.id} and id <> ${user.session_id} and revoked_at is null`;
    return json({ ok: true });
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
      for (const line of String(mx.ranges ?? "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const r = /^(.+?)[\s:]+(\d+)\s*(?:-|–|to)\s*(\d+)$/i.exec(t);
        if (!r || !normMatric(r[1])) throw new HttpError(400, `Couldn't read "${t}". Write each range like: 22/66MG 001-250`);
        const start = parseInt(r[2], 10), end = parseInt(r[3], 10);
        if (end < start) throw new HttpError(400, `In "${t}" the last number is smaller than the first.`);
        rules.push({ kind: "range", prefix: normMatric(r[1]), start, end, width: r[2].length === r[3].length && r[2].length > 1 ? r[2].length : null });
      }
      if (!rules.length) throw new HttpError(400, "Add at least one matric range, for example: 22/66MG 001-250");
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

    const canPost = async () => {
      if (mem.chat_mode === "admins_only" && !isAdmin(mem.role)) throw new HttpError(403, "Only admins can post right now.");
      if (mem.slow_mode_s > 0 && !isAdmin(mem.role)) {
        const [last] = await sql`select extract(epoch from now() - max(created_at))::int as ago from messages where room_id = ${roomId} and user_id = ${user.id}`;
        if (last?.ago != null && last.ago < mem.slow_mode_s)
          throw new HttpError(429, `Slow mode is on. Wait ${mem.slow_mode_s - last.ago}s before sending again.`);
      }
    };

    if (m === "GET" && sub === "/messages") {
      const after = parseInt(url.searchParams.get("after") ?? "", 10);
      const before = parseInt(url.searchParams.get("before") ?? "", 10);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
      let rows: any[];
      if (after >= 0) {
        rows = await sql`select m.id, m.client_id, m.user_id, m.kind, m.body, m.created_at, u.display_name, v.id as voice_id, v.duration_ms
          from messages m join users u on u.id = m.user_id left join voice_notes v on v.message_id = m.id
          where m.room_id = ${roomId} and m.deleted_at is null and m.id > ${after}
          order by m.id asc limit ${limit}`;
      } else {
        rows = await sql`select m.id, m.client_id, m.user_id, m.kind, m.body, m.created_at, u.display_name, v.id as voice_id, v.duration_ms
          from messages m join users u on u.id = m.user_id left join voice_notes v on v.message_id = m.id
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
      await canPost();
      // 1) SAVE to PostgreSQL. If this throws, nothing is broadcast and the client sees an error.
      let [saved] = await sql`with ins as (
          insert into messages (room_id, user_id, client_id, body) values (${roomId}, ${user.id}, ${b.clientId}, ${text})
          on conflict (room_id, user_id, client_id) do nothing returning *)
        select ins.id, ins.client_id, ins.user_id, ins.kind, ins.body, ins.created_at, ${user.display_name}::text as display_name,
               null::uuid as voice_id, null::int as duration_ms from ins`;
      if (saved) {
        // 2) ONLY NOW tell everyone else (in the background, so the sender isn't kept waiting).
        bcast(roomId, { type: "message", message: saved });
        return json({ message: saved }, 201);
      }
      // Same clientId retried: return the stored copy, don't duplicate.
      [saved] = await sql`select m.id, m.client_id, m.user_id, m.kind, m.body, m.created_at, u.display_name, null::uuid as voice_id, null::int as duration_ms
        from messages m join users u on u.id = m.user_id
        where m.room_id = ${roomId} and m.user_id = ${user.id} and m.client_id = ${b.clientId}`;
      return json({ message: saved }, 200);
    }

    if (m === "POST" && sub === "/voice") {
      const clientId = req.headers.get("x-client-id") ?? "";
      if (!isUuid(clientId)) throw new HttpError(400, "Invalid message id.");
      await canPost();
      const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!/^audio\/(webm|ogg|mp4|aac|mpeg|x-m4a|m4a)$/.test(mime)) throw new HttpError(400, "This audio format isn't supported.");
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.length) throw new HttpError(400, "The recording was empty.");
      if (data.length > 700_000) throw new HttpError(413, "That voice note is too long. Keep it under 60 seconds.");
      const dur = Math.min(Math.max(parseInt(req.headers.get("x-duration-ms") ?? "0", 10) || 0, 0), 60000);
      const saved = await sql.begin(async (tx: any) => {
        const [ins] = await tx`insert into messages (room_id, user_id, client_id, kind, body)
          values (${roomId}, ${user.id}, ${clientId}, 'voice', 'Voice note')
          on conflict (room_id, user_id, client_id) do nothing returning id, client_id, user_id, kind, body, created_at`;
        if (!ins) return null;
        const [v] = await tx`insert into voice_notes (message_id, room_id, user_id, mime, duration_ms, data)
          values (${ins.id}, ${roomId}, ${user.id}, ${mime}, ${dur}, ${data}) returning id`;
        return { ...ins, display_name: user.display_name, voice_id: v.id, duration_ms: dur };
      });
      if (saved) {
        bcast(roomId, { type: "message", message: saved });
        return json({ message: saved }, 201);
      }
      const [existing] = await sql`select m.id, m.client_id, m.user_id, m.kind, m.body, m.created_at, u.display_name, v.id as voice_id, v.duration_ms
        from messages m join users u on u.id = m.user_id left join voice_notes v on v.message_id = m.id
        where m.room_id = ${roomId} and m.user_id = ${user.id} and m.client_id = ${clientId}`;
      return json({ message: existing }, 200);
    }

    const vm = /^\/voice\/([0-9a-f-]{36})$/i.exec(sub);
    if (m === "GET" && vm) {
      const [v] = await sql`select data, mime from voice_notes where id = ${vm[1]} and room_id = ${roomId}`;
      if (!v) throw new HttpError(404, "Voice note not found.");
      const bytes: Uint8Array = v.data;
      const total = bytes.length;
      const base: Record<string, string> = { "content-type": v.mime, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? ""); // iPhones need Range support to play audio
      if (range && (range[1] || range[2])) {
        const start = range[1] ? parseInt(range[1], 10) : Math.max(total - parseInt(range[2], 10), 0);
        const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), total - 1) : total - 1;
        if (start > end || start >= total) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
        return new Response(bytes.subarray(start, end + 1), {
          status: 206,
          headers: { ...base, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) },
        });
      }
      return new Response(bytes, { headers: { ...base, "content-length": String(total) } });
    }

    if (m === "GET" && sub === "/polls") {
      const polls = await sql`select p.id, p.question, p.created_at, u.display_name as author,
          (select option_id from poll_votes v where v.poll_id = p.id and v.user_id = ${user.id}) as my_vote,
          coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label,
            'votes', (select count(*)::int from poll_votes v2 where v2.option_id = o.id)) order by o.position)
            from poll_options o where o.poll_id = p.id), '[]'::json) as options
        from polls p join users u on u.id = p.created_by
        where p.room_id = ${roomId} order by p.created_at desc limit 30`;
      return json({ polls });
    }

    if (m === "POST" && sub === "/polls") {
      if (!isAdmin(mem.role)) throw new HttpError(403, "Only admins can create polls.");
      const b = await body();
      const question = str(b.question, 200);
      const options = (Array.isArray(b.options) ? b.options : []).map((o: any) => str(o, 80)).filter(Boolean).slice(0, 6);
      if (question.length < 2) throw new HttpError(400, "Write the poll question.");
      if (options.length < 2) throw new HttpError(400, "Add at least two options.");
      const poll = await sql.begin(async (tx: any) => {
        const [pl] = await tx`insert into polls (room_id, created_by, question) values (${roomId}, ${user.id}, ${question}) returning id, question, created_at`;
        const opts: any[] = [];
        for (let i = 0; i < options.length; i++) {
          const [o] = await tx`insert into poll_options (poll_id, label, position) values (${pl.id}, ${options[i]}, ${i}) returning id, label`;
          opts.push({ id: o.id, label: o.label, votes: 0 });
        }
        await tx`insert into audit_log (room_id, actor_id, action, target_type, target_id) values (${roomId}, ${user.id}, 'poll.create', 'poll', ${pl.id})`;
        return { ...pl, author: user.display_name, my_vote: null, options: opts };
      });
      bcast(roomId, { type: "poll", poll });
      return json({ poll }, 201);
    }

    const pv = /^\/polls\/([0-9a-f-]{36})\/vote$/i.exec(sub);
    if (m === "POST" && pv) {
      const b = await body();
      const [opt] = await sql`select o.id from poll_options o join polls p on p.id = o.poll_id
        where p.id = ${pv[1]} and p.room_id = ${roomId} and o.id = ${String(b.optionId ?? "")}`;
      if (!opt) throw new HttpError(404, "That poll option doesn't exist.");
      await sql`insert into poll_votes (poll_id, user_id, option_id) values (${pv[1]}, ${user.id}, ${opt.id})
        on conflict (poll_id, user_id) do update set option_id = excluded.option_id, created_at = now()`;
      const rows = await sql`select o.id, (select count(*)::int from poll_votes v where v.option_id = o.id) as votes
        from poll_options o where o.poll_id = ${pv[1]}`;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.id] = r.votes;
      bcast(roomId, { type: "poll_votes", pollId: pv[1], counts });
      return json({ pollId: pv[1], counts, myVote: opt.id });
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
      bcast(roomId, { type: "room", chat_mode: chatMode, slow_mode_s: slow });
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
      return await handle(req, env, sql, ctx);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("API error", e);
      return json({ error: "Something went wrong on our side. Nothing was lost. Please try again." }, 500);
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
