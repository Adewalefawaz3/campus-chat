import "./style.css";

const app = document.getElementById("app")!;
const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const $ = (sel: string) => document.querySelector(sel) as any;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const initials = (s: string) => String(s || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const ago = (t: string) => {
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d";
};
const mmss = (ms: number) => { const s = Math.round((ms || 0) / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const ICON_MIC = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const ICON_PLAY = `<svg class="pl" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg class="pa" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;

/* ---------- theme (dark by default) ---------- */
const applyTheme = (t: string) => document.documentElement.setAttribute("data-theme", t);
applyTheme(localStorage.getItem("theme") || "dark");
const toggleTheme = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
};

/* ---------- API (retries only when the network drops or the server errors) ---------- */
class ApiError extends Error { status = 0; }
async function api(path: string, opts: { method?: string; body?: any; retries?: number; raw?: Blob; headers?: Record<string, string> } = {}) {
  const tries = (opts.retries ?? 0) + 1;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(path, {
        method: opts.method ?? (opts.body || opts.raw ? "POST" : "GET"),
        headers: { ...(opts.raw ? {} : { "content-type": "application/json" }), ...(opts.headers ?? {}) },
        body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status >= 500 && i < tries - 1) { await wait(700 * 2 ** i); continue; }
      if (res.status === 401 && me) { me = null; render(); }
      const e = new ApiError(data.error || "Request failed."); e.status = res.status; throw e;
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      if (i < tries - 1) { await wait(700 * 2 ** i); continue; }
      throw new ApiError("No connection. Check your data or Wi-Fi and try again.");
    }
  }
}

/* ---------- state ---------- */
let me: any = null;
let rooms: any[] = [];
let ws: WebSocket | null = null;
let pingTimer: any = null;
let idleTimer: any = null;
let currentRoom = "";
const voiceAudio = new Audio();

const go = (path: string) => { history.pushState(null, "", path); render(); };
window.addEventListener("popstate", () => render());

function armIdleLogout() {
  clearTimeout(idleTimer);
  if (!me?.shared) return;
  idleTimer = setTimeout(() => logout(), 20 * 60 * 1000); // the server enforces this too
}
["click", "keydown", "touchstart"].forEach((ev) => window.addEventListener(ev, armIdleLogout, { passive: true }));

async function loadMe() {
  try { const d = await api("/api/me"); me = d.user; rooms = d.rooms; } catch { me = null; }
  armIdleLogout();
}
async function logout() {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {}
  me = null; rooms = []; closeSocket(); go("/");
}
function closeSocket() {
  clearInterval(pingTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  currentRoom = "";
  voiceAudio.pause();
}

/* ---------- router ---------- */
function render() {
  const path = location.pathname;
  const invite = /^\/j\/([A-Za-z0-9-]+)/.exec(path);
  const room = /^\/r\/([0-9a-f-]{36})/i.exec(path);
  if (!room) closeSocket();
  if (invite && !me) return renderAuth(invite[1]);
  if (invite) return renderJoin(invite[1]);
  if (!me) return renderAuth();
  if (room) return renderRoom(room[1]);
  if (path === "/new") return renderNewRoom();
  if (path === "/join") return renderJoin("");
  if (path === "/profile") return renderProfile();
  return renderHome();
}

/* ---------- auth ---------- */
function renderAuth(inviteCode?: string) {
  let mode: "login" | "signup" = "login";
  const draw = () => {
    app.innerHTML = `<div class="center"><div class="card">
      <h1>Campus Chat</h1>
      <p class="muted">${inviteCode ? "Sign in or create an account to join the room." : "Class groups you can open from any browser, no phone needed."}</p>
      <form id="f">
        ${mode === "signup" ? `<label>Your name</label><input name="displayName" autocomplete="name" required />` : ""}
        <label>Email</label><input name="email" type="email" autocomplete="username" required />
        <label>Password</label><input name="password" type="password" minlength="8" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required />
        ${mode === "signup" ? `<label>School (optional)</label><input name="school" placeholder="e.g. University of Ilorin" />
        <label>Matric number (optional)</label><input name="matric" placeholder="e.g. 22/66MG034" autocapitalize="characters" />
        <p class="hint">Type it the way you write it. Slashes and capital letters don't matter.</p>` : ""}
        <label class="check"><input type="checkbox" name="shared" /> I'm on a shared or public device</label>
        <p class="err" id="err"></p>
        <button class="primary" style="width:100%;margin-top:6px">${mode === "login" ? "Sign in" : "Create account"}</button>
      </form>
      <p class="muted" style="margin-top:14px"><button class="link" id="sw" type="button">${mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}</button>
      <button class="link" id="th" type="button">Theme</button></p></div></div>`;
    $("#sw").onclick = () => { mode = mode === "login" ? "signup" : "login"; draw(); };
    $("#th").onclick = toggleTheme;
    $("#f").onsubmit = async (e: Event) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
      fd.shared = !!fd.shared;
      const btn = $("#f button.primary"); btn.disabled = true;
      try {
        await api(mode === "login" ? "/api/auth/login" : "/api/auth/signup", { body: fd });
        await loadMe();
        render();
      } catch (er: any) { $("#err").textContent = er.message; btn.disabled = false; }
    };
  };
  draw();
}

/* ---------- shell (desktop sidebar; phones use the dashboard instead) ---------- */
function shell(inner: string, active = "", mode = active ? "room" : "home") {
  const p = location.pathname;
  return `<div class="shell ${mode}">
    <aside class="rail"><div class="brand">Campus Chat</div>
      <button class="nav ${p === "/" ? "on" : ""}" data-go="/">Dashboard</button>
      <button class="nav ${p === "/new" ? "on" : ""}" data-go="/new">New room</button>
      <button class="nav ${p === "/join" ? "on" : ""}" data-go="/join">Join with a code</button>
      <div class="sep"></div>
      ${rooms.map((r) => `<button class="room ${r.id === active ? "on" : ""}" data-room="${r.id}"><span class="badge">${esc(initials(r.name))}</span>${esc(r.name)}</button>`).join("") || `<p class="muted" style="padding:0 10px">No rooms yet.</p>`}
      <div class="spacer"></div><div class="sep"></div>
      <button class="nav ${p === "/profile" ? "on" : ""}" data-go="/profile"><span class="badge" style="width:30px;height:30px;border-radius:50%;font-size:.75rem">${esc(initials(me.display_name))}</span>${esc(me.display_name)}</button>
    </aside>${inner}</div>`;
}
function wireShell() {
  document.querySelectorAll("[data-back]").forEach((b: any) => (b.onclick = () => go("/")));
  document.querySelectorAll("[data-room]").forEach((b: any) => (b.onclick = () => go("/r/" + b.dataset.room)));
  document.querySelectorAll("[data-go]").forEach((b: any) => (b.onclick = () => go(b.dataset.go)));
}

/* ---------- dashboard ---------- */
function renderHome() {
  const admin = rooms.filter((r) => r.role !== "member").length;
  const people = rooms.reduce((n, r) => n + (r.members || 0), 0);
  app.innerHTML = shell(`<main class="main"><div class="wrap">
    <div class="hello"><div><h1>Hi, ${esc(me.display_name.split(" ")[0])}</h1><p class="muted" style="margin:0">Your campus rooms in one place.</p></div>
      <button class="avatar" data-go="/profile" aria-label="Profile">${esc(initials(me.display_name))}</button></div>
    <div class="stats">
      <div class="stat"><b>${rooms.length}</b><span class="muted">Rooms</span></div>
      <div class="stat"><b>${admin}</b><span class="muted">You manage</span></div>
      <div class="stat"><b>${people}</b><span class="muted">People</span></div>
    </div>
    <div class="row wrapx"><button class="primary" data-go="/new">New room</button><button data-go="/join">Join with a code</button></div>
    <h2 style="margin-top:22px">Your rooms</h2>
    <div class="cards">${rooms.map((r) => `<button class="rc" data-room="${r.id}"><span class="badge">${esc(initials(r.name))}</span>
      <span class="rc-body"><span class="rc-top"><strong>${esc(r.name)}</strong>${r.role !== "member" ? `<span class="chip adm">Admin</span>` : ""}<span class="chip">${r.members} ${r.members === 1 ? "member" : "members"}</span></span>
      <span class="muted rc-last">${r.last_at ? `${esc(r.last_by)}: ${r.last_kind === "voice" ? "Voice note" : esc(r.last_body)}` : "No messages yet"}</span></span>
      <span class="muted">${r.last_at ? ago(r.last_at) : ""}</span></button>`).join("") ||
      `<div class="empty">No rooms yet. Create one for your class, or join with a code from your course rep.</div>`}</div>
  </div></main>`);
  wireShell();
}

/* ---------- profile ---------- */
async function renderProfile() {
  let d: any;
  try { d = await api("/api/profile"); } catch { return go("/"); }
  const idn = d.identities[0];
  app.innerHTML = shell(`<main class="main"><div class="wrap narrow">
    <button class="link back" data-back type="button">← Back</button>
    <div class="hello"><div><h1>Profile</h1><p class="muted" style="margin:0">${esc(d.user.email)}</p></div><span class="avatar" style="display:grid;place-items:center">${esc(initials(d.user.display_name))}</span></div>
    <div class="card"><h2>Your details</h2>
      <form id="pf"><label>Name</label><input name="displayName" value="${esc(d.user.display_name)}" required />
        <label>School</label><input name="school" value="${esc(idn?.school ?? "")}" placeholder="e.g. University of Ilorin" ${idn ? "readonly" : ""} />
        <label>Matric number</label><input name="matric" value="${esc(idn?.matric_raw ?? "")}" placeholder="e.g. 22/66MG034" autocapitalize="characters" ${idn ? "readonly" : ""} />
        <p class="hint">${idn ? "Your matric number is locked once saved. Ask a room admin if it needs correcting." : "Add it once so matric-locked rooms can let you in."}</p>
        <p class="err" id="perr"></p><button class="primary">Save</button></form></div>
    <div class="card" style="margin-top:12px"><h2>Change password</h2>
      <form id="pw"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required />
        <label>New password</label><input name="next" type="password" minlength="8" autocomplete="new-password" required />
        <p class="err" id="wmsg"></p><button class="primary">Change password</button></form></div>
    <div class="card" style="margin-top:12px"><h2>This device</h2>
      <div class="row wrapx"><button id="th2" type="button">Switch light / dark</button><button id="out" type="button">Sign out</button><button id="outall" type="button">Sign out other devices</button></div></div>
  </div></main>`, "", "sub");
  wireShell();
  $("#th2").onclick = toggleTheme;
  $("#out").onclick = logout;
  $("#outall").onclick = async () => { await api("/api/auth/logout-all", { body: {} }).catch(() => {}); alert("Other devices have been signed out."); };
  $("#pf").onsubmit = async (e: Event) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
    try { await api("/api/profile", { body: fd }); await loadMe(); $("#perr").className = "ok"; $("#perr").textContent = "Saved."; }
    catch (er: any) { $("#perr").className = "err"; $("#perr").textContent = er.message; }
  };
  $("#pw").onsubmit = async (e: Event) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
    try { await api("/api/profile/password", { body: fd }); $("#wmsg").className = "ok"; $("#wmsg").textContent = "Password changed. Other devices were signed out."; (e.target as HTMLFormElement).reset(); }
    catch (er: any) { $("#wmsg").className = "err"; $("#wmsg").textContent = er.message; }
  };
}

/* ---------- create / join ---------- */
function renderNewRoom() {
  app.innerHTML = shell(`<main class="main"><div class="wrap narrow"><div class="card">
    <button class="link back" data-back type="button">← Back</button><h2>New room</h2>
    <form id="f">
      <label>Room name</label><input name="name" placeholder="e.g. 100L Microbiology" required />
      <label>Type</label><select name="kind"><option value="departmental">Departmental (class)</option><option value="general">General (hostel, club, team)</option></select>
      <div id="dep">
        <label>School</label><input name="school" placeholder="e.g. University of Ilorin" />
        <label>Department</label><input name="department" />
        <label>Level</label><input name="level" placeholder="e.g. 100L" />
        <label>Who can join</label><select name="joinMode"><option value="matric_locked">Only matric numbers in my list</option><option value="code_only">Anyone with the code</option></select>
        <div id="mx">
          <label>Matric ranges (one per line)</label>
          <textarea name="ranges" rows="3" placeholder="22/66MG 001-250&#10;21/66MG 001-180" autocapitalize="characters"></textarea>
          <p class="hint">Write the part before the number, a space, then the number range. Students can type 22/66MG034 or 22/66mg/034, both match. Add a line for each set.</p>
          <label>Also allow (direct entry, carry-overs), comma separated</label><textarea name="allow" rows="2" placeholder="22/66MG301, DE/66MG005"></textarea>
          <label>Block these matric numbers</label><textarea name="block" rows="2"></textarea>
        </div>
      </div>
      <p class="err" id="err"></p>
      <button class="primary" style="width:100%">Create room</button>
    </form></div></div></main>`, "", "sub");
  wireShell();
  const sync = () => {
    const f = $("#f"), dep = f.kind.value === "departmental";
    $("#dep").style.display = dep ? "" : "none";
    $("#mx").style.display = dep && f.joinMode.value === "matric_locked" ? "" : "none";
  };
  $("#f").onchange = sync; sync();
  $("#f").onsubmit = async (e: Event) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
    const body = { ...fd, matric: { ranges: fd.ranges, allow: fd.allow, block: fd.block } };
    try { const d = await api("/api/rooms", { body }); await loadMe(); go("/r/" + d.room.id); }
    catch (er: any) { $("#err").textContent = er.message; }
  };
}

async function renderJoin(code: string) {
  let preview: any = null;
  if (code) { try { preview = (await api("/api/invite/" + code)).room; } catch (e: any) { preview = { error: e.message }; } }
  const needsMatric = !code || preview?.join_mode === "matric_locked";
  const inner = `<main class="main"><div class="wrap narrow"><div class="card">${me ? `<button class="link back" data-back type="button">← Back</button>` : ""}<h2>Join a room</h2>
    ${preview?.error ? `<p class="err">${esc(preview.error)}</p>` : preview ? `<p><strong>${esc(preview.name)}</strong><br><span class="muted">${esc([preview.school, preview.department, preview.level].filter(Boolean).join(", "))}</span></p>` : ""}
    <form id="f">
      ${code ? "" : `<label>Room code</label><input name="code" class="code" autocapitalize="characters" required />`}
      ${needsMatric ? `<label>Matric number (only if the room asks for it)</label><input name="matric" placeholder="e.g. 22/66MG034" autocapitalize="characters" />` : ""}
      <p class="err" id="err"></p>
      <button class="primary" style="width:100%">Join room</button>
    </form></div></div></main>`;
  app.innerHTML = me ? shell(inner, "", "sub") : inner;
  if (me) wireShell();
  $("#f").onsubmit = async (e: Event) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
    try { const d = await api("/api/join", { body: { code: code || fd.code, matric: fd.matric } }); await loadMe(); go("/r/" + d.roomId); }
    catch (er: any) { $("#err").textContent = er.message; }
  };
}

/* ---------- room: saved-first messaging, polls, voice notes ---------- */
async function renderRoom(id: string) {
  let info: any;
  try { info = await api("/api/rooms/" + id); } catch { return go("/"); }
  const admin = info.role !== "member";
  let chatMode = info.room.chat_mode, slow = info.room.slow_mode_s, code = info.code;
  let tab = "chat";
  const saved = new Map<number, any>();     // confirmed saved in PostgreSQL
  const pending = new Map<string, any>();   // waiting for the server to confirm
  const polls = new Map<string, any>();
  let lastId = 0;

  app.innerHTML = shell(`<main class="main">
    <div class="top"><div class="row"><button class="link back" id="back" type="button">← Rooms</button><strong>${esc(info.room.name)}</strong> <span class="muted" id="state"></span></div>
      ${admin ? `<button id="tools">Admin tools</button>` : ""}</div>
    <div id="panel" class="panel" hidden></div>
    <div id="banner" class="banner" hidden></div>
    <div class="tabs"><button class="on" data-tab="chat">Chat</button><button data-tab="polls">Polls</button></div>
    <div id="chatview" style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="msgs" id="msgs"></div>
      <div class="rec" id="rec" hidden><span class="dot"></span><span id="rtime">0:00</span><span class="muted" style="flex:1">Recording...</span>
        <button type="button" id="rcancel">Cancel</button><button type="button" class="primary" id="rsend">Send</button></div>
      <form class="compose" id="send"><input id="text" placeholder="Write a message" autocomplete="off" maxlength="2000" />
        <button type="button" class="icon" id="mic" aria-label="Record voice note">${ICON_MIC}</button><button class="primary">Send</button></form>
    </div>
    <div id="pollview" class="polls" hidden></div>
  </main>`, id);
  wireShell();
  $("#back").onclick = () => go("/");
  currentRoom = id;

  /* chat drawing */
  const bubble = (m: any, pend = false) => {
    const mine = m.user_id === me.id || pend;
    const who = `<div class="who">${pend ? (m.failed ? "Not sent" : "Sending...") : esc(m.display_name)}</div>`;
    const retry = pend && m.failed ? `<div><button class="link" data-retry="${m.clientId}">Try again</button><button class="link" data-drop="${m.clientId}">Delete</button></div>` : "";
    const body = pend && m.voice ? `Voice note (${mmss(m.dur)})`
      : m.kind === "voice" && m.voice_id ? `<div class="vn"><button class="play" data-voice="${m.voice_id}" type="button" aria-label="Play">${ICON_PLAY}</button><div class="bar"><i></i></div><span class="muted">${mmss(m.duration_ms)}</span></div>`
      : esc(m.body);
    return `<div class="msg ${mine ? "mine" : ""} ${pend ? (m.failed ? "failed" : "pending") : ""}">${who}${body}${retry}</div>`;
  };
  let nowId = "";
  const syncPlayers = () => {
    document.querySelectorAll(".play").forEach((b: any) => b.classList.toggle("on", b.dataset.voice === nowId && !voiceAudio.paused));
    const cur = nowId && (document.querySelector(`.play[data-voice="${nowId}"]`) as any);
    const fill = cur?.parentElement.querySelector(".bar i");
    if (fill) fill.style.width = voiceAudio.duration ? (voiceAudio.currentTime / voiceAudio.duration) * 100 + "%" : "0%";
  };
  const draw = () => {
    const box = $("#msgs");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = [...saved.values()].sort((a, b) => a.id - b.id).map((m) => bubble(m)).join("") + [...pending.values()].map((m) => bubble(m, true)).join("");
    if (stick) box.scrollTop = box.scrollHeight;
    box.querySelectorAll("[data-retry]").forEach((b: any) => (b.onclick = () => send(pending.get(b.dataset.retry))));
    box.querySelectorAll("[data-drop]").forEach((b: any) => (b.onclick = () => { pending.delete(b.dataset.drop); draw(); }));
    syncPlayers();
  };
  $("#msgs").onclick = (e: any) => {
    const b = e.target.closest(".play"); if (!b) return;
    const vid = b.dataset.voice;
    if (nowId === vid && !voiceAudio.paused) { voiceAudio.pause(); return; }
    if (nowId !== vid) { voiceAudio.src = `/api/rooms/${id}/voice/${vid}`; nowId = vid; }
    voiceAudio.play().catch(() => alert("Couldn't play this voice note."));
  };
  voiceAudio.onplay = voiceAudio.onpause = voiceAudio.ontimeupdate = syncPlayers;
  voiceAudio.onended = () => { nowId = ""; syncPlayers(); document.querySelectorAll(".bar i").forEach((i: any) => (i.style.width = "0")); };

  const addSaved = (m: any) => { saved.set(+m.id, m); lastId = Math.max(lastId, +m.id); pending.delete(m.client_id); };
  const applyMode = () => {
    const locked = chatMode === "admins_only" && !admin;
    $("#text").disabled = locked; $("#send button.primary").disabled = locked; $("#mic").disabled = locked;
    $("#text").placeholder = locked ? "Only admins can post right now" : "Write a message";
    const b = $("#banner");
    b.hidden = !(chatMode === "admins_only" || slow > 0);
    b.textContent = chatMode === "admins_only" ? "Admins-only mode: members can read but not post." : `Slow mode: one message every ${slow}s.`;
  };
  applyMode();

  /* sending: only shown as sent after PostgreSQL confirmed it */
  const send = async (m: any) => {
    m.failed = false; draw();
    try {
      const d = m.voice
        ? await api(`/api/rooms/${id}/voice`, { raw: m.blob, retries: 2, headers: { "content-type": m.mime, "x-client-id": m.clientId, "x-duration-ms": String(m.dur) } })
        : await api(`/api/rooms/${id}/messages`, { body: { body: m.body, clientId: m.clientId }, retries: 3 });
      addSaved(d.message);
    } catch (e: any) { m.failed = true; if (e.status === 403 || e.status === 429) alert(e.message); }
    draw();
  };
  $("#send").onsubmit = (e: Event) => {
    e.preventDefault();
    const body = $("#text").value.trim(); if (!body) return;
    $("#text").value = "";
    const m = { clientId: crypto.randomUUID(), body };
    pending.set(m.clientId, m); send(m);
  };

  /* voice notes (max 60 s) */
  let rec: any = null;
  const hideRec = () => { $("#rec").hidden = true; $("#send").hidden = false; };
  const stopRec = (doSend: boolean) => {
    if (!rec) return;
    rec.cancel = !doSend; clearInterval(rec.timer);
    try { rec.mr.stop(); } catch {}
    hideRec();
  };
  $("#mic").onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return alert("This browser can't record voice notes.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find((t) => (MediaRecorder as any).isTypeSupported(t));
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 });
      const chunks: Blob[] = [];
      const start = Date.now();
      rec = { mr, cancel: false, timer: 0 };
      mr.ondataavailable = (ev: any) => ev.data.size && chunks.push(ev.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const r = rec; rec = null;
        const type = (mr.mimeType || mime || "audio/webm").split(";")[0];
        if (!r || r.cancel || !chunks.length) return;
        const m = { clientId: crypto.randomUUID(), voice: true, blob: new Blob(chunks, { type }), mime: type, dur: Math.min(Date.now() - start, 60000) };
        pending.set(m.clientId, m); send(m);
      };
      mr.start();
      $("#rec").hidden = false; $("#send").hidden = true;
      rec.timer = setInterval(() => {
        const ms = Date.now() - start; $("#rtime").textContent = mmss(ms);
        if (ms >= 60000) stopRec(true);
      }, 250);
    } catch { alert("Allow microphone access to record a voice note."); }
  };
  $("#rcancel").onclick = () => stopRec(false);
  $("#rsend").onclick = () => stopRec(true);

  /* polls */
  const pollTotal = (p: any) => p.options.reduce((n: number, o: any) => n + o.votes, 0);
  const drawPolls = () => {
    const list = [...polls.values()].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    $("#pollview").innerHTML = (admin ? `<div><button class="primary" id="newpoll">New poll</button><form id="pform" hidden class="card" style="margin-top:10px">
        <label style="margin-top:0">Question</label><input name="question" maxlength="200" required />
        <label>Options (one per line, 2 to 6)</label><textarea name="options" rows="4" required></textarea>
        <p class="err" id="poerr"></p><button class="primary">Post poll</button></form></div>` : "") +
      (list.map((p) => { const t = pollTotal(p); return `<div class="poll"><strong>${esc(p.question)}</strong><div class="muted">by ${esc(p.author)} · ${t} ${t === 1 ? "vote" : "votes"}</div>
        ${p.options.map((o: any) => { const pc = t ? Math.round((o.votes / t) * 100) : 0; return `<button class="opt ${p.my_vote === o.id ? "on" : ""}" data-poll="${p.id}" data-opt="${o.id}"><i style="width:${pc}%"></i><span>${esc(o.label)}</span><b>${pc}%</b></button>`; }).join("")}</div>`; }).join("") ||
        `<div class="empty">No polls yet.${admin ? " Create the first one." : ""}</div>`);
    document.querySelectorAll("[data-opt]").forEach((b: any) => (b.onclick = async () => {
      try {
        const d = await api(`/api/rooms/${id}/polls/${b.dataset.poll}/vote`, { body: { optionId: b.dataset.opt } });
        const p = polls.get(b.dataset.poll); p.my_vote = d.myVote; p.options.forEach((o: any) => (o.votes = d.counts[o.id] ?? 0)); drawPolls();
      } catch (e: any) { alert(e.message); }
    }));
    if (admin) {
      $("#newpoll").onclick = () => { $("#pform").hidden = !$("#pform").hidden; };
      $("#pform").onsubmit = async (e: Event) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
        try { const d = await api(`/api/rooms/${id}/polls`, { body: { question: fd.question, options: String(fd.options).split("\n") } }); polls.set(d.poll.id, d.poll); drawPolls(); }
        catch (er: any) { $("#poerr").textContent = er.message; }
      };
    }
  };
  document.querySelectorAll("[data-tab]").forEach((b: any) => (b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((x: any) => x.classList.toggle("on", x === b));
    $("#chatview").style.display = tab === "chat" ? "flex" : "none";
    $("#pollview").hidden = tab !== "polls";
    if (tab === "polls") drawPolls();
  }));

  /* initial load */
  const catchUp = async () => {
    try { (await api(`/api/rooms/${id}/messages?after=${lastId}&limit=200`)).messages.forEach(addSaved); draw(); } catch {}
  };
  try { (await api(`/api/rooms/${id}/messages?limit=50`)).messages.forEach(addSaved); } catch (e: any) { $("#msgs").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  draw(); $("#msgs").scrollTop = $("#msgs").scrollHeight;
  api(`/api/rooms/${id}/polls`).then((d) => { d.polls.forEach((p: any) => polls.set(p.id, p)); if (tab === "polls") drawPolls(); }).catch(() => {});

  /* live updates */
  let backoff = 1000;
  const connect = () => {
    if (currentRoom !== id) return;
    $("#state").textContent = "connecting...";
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + `/api/rooms/${id}/ws`);
    ws.onopen = () => { backoff = 1000; $("#state").textContent = ""; catchUp(); clearInterval(pingTimer); pingTimer = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 30000); };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      const e = JSON.parse(ev.data);
      if (e.type === "message") { addSaved(e.message); draw(); }
      if (e.type === "room") { chatMode = e.chat_mode; slow = e.slow_mode_s; applyMode(); }
      if (e.type === "poll") { polls.set(e.poll.id, e.poll); if (tab === "polls") drawPolls(); }
      if (e.type === "poll_votes") { const p = polls.get(e.pollId); if (p) { p.options.forEach((o: any) => (o.votes = e.counts[o.id] ?? 0)); if (tab === "polls") drawPolls(); } }
    };
    ws.onclose = () => { if (currentRoom !== id) return; $("#state").textContent = "reconnecting..."; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); };
  };
  connect();

  /* admin tools */
  if (admin) {
    const panel = $("#panel");
    const drawPanel = () => {
      panel.innerHTML = `<div>Invite link: <span class="code">${esc(location.origin)}/j/${esc(code ?? "")}</span></div>
        <div class="row wrapx" style="margin-top:8px"><button id="copy">Copy link</button><button id="rot">Make a new link</button></div>
        <div class="row wrapx" style="margin-top:12px">
          <label class="check" style="margin:0"><input type="checkbox" id="adm" ${chatMode === "admins_only" ? "checked" : ""}/> Admins-only mode</label>
          <label style="margin:0">Slow mode</label>
          <select id="slow" style="width:auto">${[0, 15, 30, 60].map((s) => `<option value="${s}" ${s === slow ? "selected" : ""}>${s ? s + "s" : "Off"}</option>`).join("")}</select>
        </div><p class="err" id="perr"></p>`;
      $("#copy").onclick = () => navigator.clipboard?.writeText(`${location.origin}/j/${code}`);
      $("#rot").onclick = async () => {
        if (!confirm("The old link will stop working. Current members stay in. Continue?")) return;
        try { code = (await api(`/api/rooms/${id}/invite/rotate`, { body: {} })).code; drawPanel(); } catch (e: any) { $("#perr").textContent = e.message; }
      };
      const save = async () => {
        try { const d = await api(`/api/rooms/${id}/settings`, { body: { chatMode: $("#adm").checked ? "admins_only" : "open", slowModeS: $("#slow").value } }); chatMode = d.chat_mode; slow = d.slow_mode_s; applyMode(); }
        catch (e: any) { $("#perr").textContent = e.message; }
      };
      $("#adm").onchange = save; $("#slow").onchange = save;
    };
    $("#tools").onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); };
  }
}

(async () => { await loadMe(); render(); })();
