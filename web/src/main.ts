import "./style.css";

const app = document.getElementById("app")!;
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const $ = (sel: string) => document.querySelector(sel) as any;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- theme (light by default) ---------- */
const applyTheme = (t: string) => document.documentElement.setAttribute("data-theme", t);
applyTheme(localStorage.getItem("theme") || "light");
const toggleTheme = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
};

/* ---------- API (retries only when the network drops or the server errors) ---------- */
class ApiError extends Error { status = 0; }
async function api(path: string, opts: { method?: string; body?: any; retries?: number } = {}) {
  const tries = (opts.retries ?? 0) + 1;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(path, {
        method: opts.method ?? (opts.body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status >= 500 && i < tries - 1) { await wait(800 * 2 ** i); continue; }
      if (res.status === 401 && me) { me = null; render(); }
      const e = new ApiError(data.error || "Request failed."); e.status = res.status; throw e;
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      if (i < tries - 1) { await wait(800 * 2 ** i); continue; }
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
function closeSocket() { clearInterval(pingTimer); if (ws) { ws.onclose = null; ws.close(); ws = null; } currentRoom = ""; }

/* ---------- screens ---------- */
function render() {
  const path = location.pathname;
  const invite = /^\/j\/([A-Za-z0-9-]+)/.exec(path);
  const room = /^\/r\/([0-9a-f-]{36})/i.exec(path);
  if (!room) closeSocket();
  if (invite && !me) return renderAuth(invite[1]);
  if (invite) return renderJoin(invite[1]);
  if (!me) return renderAuth();
  if (room) return renderRoom(room[1]);
  return renderHome();
}

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
        <label>Matric number (optional)</label><input name="matric" placeholder="e.g. 22/66MG/045" />` : ""}
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
        const d = await api(mode === "login" ? "/api/auth/login" : "/api/auth/signup", { body: fd });
        me = { ...d.user, shared: fd.shared };
        await loadMe();
        render();
      } catch (er: any) { $("#err").textContent = er.message; btn.disabled = false; }
    };
  };
  draw();
}

function shell(inner: string, active = "") {
  return `<div class="shell ${active ? "" : "home"}">
    <aside class="rail"><h2>Campus Chat</h2>
      ${rooms.map((r) => `<button class="room ${r.id === active ? "on" : ""}" data-room="${r.id}">${esc(r.name)}</button>`).join("") || `<p class="muted">You haven't joined any rooms yet.</p>`}
      <button class="primary" style="width:100%;margin-top:12px" id="new">New room</button>
      <button style="width:100%;margin-top:8px" id="joinbtn">Join with a code</button>
      <p class="muted" style="margin-top:16px">${esc(me.display_name)}${me.shared ? " (shared device)" : ""}</p>
      <div class="row"><button class="link" id="th">Theme</button><button class="link" id="out">Sign out</button></div>
      <button class="link" id="outall">Sign out of other devices</button>
    </aside>${inner}</div>`;
}
function wireShell() {
  document.querySelectorAll("[data-room]").forEach((b: any) => (b.onclick = () => go("/r/" + b.dataset.room)));
  $("#new").onclick = () => go("/new");
  $("#joinbtn").onclick = () => go("/join");
  $("#th").onclick = toggleTheme;
  $("#out").onclick = logout;
  $("#outall").onclick = async () => { await api("/api/auth/logout-all", { body: {} }).catch(() => {}); alert("Other devices have been signed out."); };
}

function renderHome() {
  const p = location.pathname;
  if (p === "/new") return renderNewRoom();
  if (p === "/join") return renderJoin("");
  app.innerHTML = shell(`<main class="main"><div class="center" style="margin-top:12vh"><h1>Welcome, ${esc(me.display_name)}</h1>
    <p class="muted">Pick a room on the left, create one for your class, or join with a code from your course rep.</p></div></main>`);
  wireShell();
}

function renderNewRoom() {
  app.innerHTML = shell(`<main class="main" style="overflow:auto"><div class="center" style="margin-top:4vh"><div class="card"><h2>New room</h2>
    <form id="f">
      <label>Room name</label><input name="name" placeholder="e.g. 100L Microbiology" required />
      <label>Type</label><select name="kind"><option value="departmental">Departmental (class)</option><option value="general">General (hostel, club, team)</option></select>
      <div id="dep">
        <label>School</label><input name="school" placeholder="University of Ilorin" />
        <label>Department</label><input name="department" />
        <label>Level</label><input name="level" placeholder="100L" />
        <label>Who can join</label><select name="joinMode"><option value="matric_locked">Only matric numbers in my list</option><option value="code_only">Anyone with the code</option></select>
        <div id="mx">
          <label>Matric prefix</label><input name="prefix" placeholder="22/66MG" />
          <div class="row"><div><label>From</label><input name="start" type="number" min="0" value="1" /></div>
          <div><label>To</label><input name="end" type="number" min="0" value="250" /></div>
          <div><label>Digits</label><input name="width" type="number" min="1" value="3" /></div></div>
          <label>Also allow (direct entry, carry-overs), comma separated</label><textarea name="allow" rows="2"></textarea>
          <label>Block these matric numbers</label><textarea name="block" rows="2"></textarea>
        </div>
      </div>
      <p class="err" id="err"></p>
      <button class="primary" style="width:100%">Create room</button>
    </form></div></div></main>`);
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
    const body = { ...fd, matric: { prefix: fd.prefix, start: fd.start, end: fd.end, width: fd.width, allow: fd.allow, block: fd.block } };
    try { const d = await api("/api/rooms", { body }); await loadMe(); go("/r/" + d.room.id); }
    catch (er: any) { $("#err").textContent = er.message; }
  };
}

async function renderJoin(code: string) {
  let preview: any = null;
  if (code) { try { preview = (await api("/api/invite/" + code)).room; } catch (e: any) { preview = { error: e.message }; } }
  const needsMatric = !code || preview?.join_mode === "matric_locked";
  const inner = `<main class="main"><div class="center" style="margin-top:8vh"><div class="card"><h2>Join a room</h2>
    ${preview?.error ? `<p class="err">${esc(preview.error)}</p>` : preview ? `<p><strong>${esc(preview.name)}</strong><br><span class="muted">${esc([preview.school, preview.department, preview.level].filter(Boolean).join(", "))}</span></p>` : ""}
    <form id="f">
      ${code ? "" : `<label>Room code</label><input name="code" class="code" required />`}
      ${needsMatric ? `<label>Matric number (only if the room asks for it)</label><input name="matric" placeholder="22/66MG/045" />` : ""}
      <p class="err" id="err"></p>
      <button class="primary" style="width:100%">Join room</button>
    </form></div></div></main>`;
  app.innerHTML = me ? shell(inner) : inner;
  if (me) wireShell();
  $("#f").onsubmit = async (e: Event) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as any;
    try { const d = await api("/api/join", { body: { code: code || fd.code, matric: fd.matric } }); await loadMe(); go("/r/" + d.roomId); }
    catch (er: any) { $("#err").textContent = er.message; }
  };
}

/* ---------- room: saved-first messaging ---------- */
async function renderRoom(id: string) {
  let info: any;
  try { info = await api("/api/rooms/" + id); } catch (e: any) { return go("/"); }
  const admin = info.role !== "member";
  let chatMode = info.room.chat_mode, slow = info.room.slow_mode_s, code = info.code;
  const saved = new Map<number, any>();      // messages confirmed saved in PostgreSQL
  const pending = new Map<string, any>();    // messages waiting for the server to confirm
  let lastId = 0;

  app.innerHTML = shell(`<main class="main">
    <div class="top"><div><strong>${esc(info.room.name)}</strong> <span class="muted" id="state"></span></div>
      ${admin ? `<button id="tools">Admin tools</button>` : ""}</div>
    <div id="panel" class="panel" hidden></div>
    <div id="banner" class="banner" hidden></div>
    <div class="msgs" id="msgs"></div>
    <form class="compose" id="send"><input id="text" placeholder="Write a message" autocomplete="off" maxlength="2000" /><button class="primary">Send</button></form>
  </main>`, id);
  wireShell();
  currentRoom = id;

  const draw = () => {
    const list = [...saved.values()].sort((a, b) => a.id - b.id);
    const box = $("#msgs");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML =
      list.map((m) => `<div class="msg ${m.user_id === me.id ? "mine" : ""}"><div class="who">${esc(m.display_name)}</div>${esc(m.body)}</div>`).join("") +
      [...pending.values()].map((m) => `<div class="msg mine ${m.failed ? "failed" : "pending"}"><div class="who">${m.failed ? "Not sent" : "Sending..."}</div>${esc(m.body)}
        ${m.failed ? `<div><button class="link" data-retry="${m.clientId}">Try again</button> <button class="link" data-drop="${m.clientId}">Delete</button></div>` : ""}</div>`).join("");
    if (stick) box.scrollTop = box.scrollHeight;
    box.querySelectorAll("[data-retry]").forEach((b: any) => (b.onclick = () => post(pending.get(b.dataset.retry))));
    box.querySelectorAll("[data-drop]").forEach((b: any) => (b.onclick = () => { pending.delete(b.dataset.drop); draw(); }));
  };
  const addSaved = (m: any) => { saved.set(+m.id, m); lastId = Math.max(lastId, +m.id); pending.delete(m.client_id); };
  const applyMode = () => {
    const locked = chatMode === "admins_only" && !admin;
    $("#text").disabled = locked; $("#send button").disabled = locked;
    $("#text").placeholder = locked ? "Only admins can post right now" : "Write a message";
    const b = $("#banner");
    b.hidden = !(chatMode === "admins_only" || slow > 0);
    b.textContent = chatMode === "admins_only" ? "Admins-only mode: members can read but not post." : `Slow mode: one message every ${slow}s.`;
  };
  applyMode();

  const post = async (m: any) => {
    m.failed = false; draw();
    try {
      const d = await api(`/api/rooms/${id}/messages`, { body: { body: m.body, clientId: m.clientId }, retries: 3 });
      addSaved(d.message);              // it only appears as "sent" after the database confirmed it
    } catch (e: any) { m.failed = true; m.error = e.message; if (e.status === 403 || e.status === 429) alert(e.message); }
    draw();
  };
  $("#send").onsubmit = (e: Event) => {
    e.preventDefault();
    const body = $("#text").value.trim(); if (!body) return;
    $("#text").value = "";
    const m = { clientId: crypto.randomUUID(), body };
    pending.set(m.clientId, m);
    post(m);
  };

  const catchUp = async () => {
    try {
      const d = await api(`/api/rooms/${id}/messages?after=${lastId}&limit=200`);
      d.messages.forEach(addSaved); draw();
    } catch {}
  };
  try { (await api(`/api/rooms/${id}/messages?limit=50`)).messages.forEach(addSaved); } catch (e: any) { $("#msgs").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  draw(); $("#msgs").scrollTop = $("#msgs").scrollHeight;

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
    };
    ws.onclose = () => { if (currentRoom !== id) return; $("#state").textContent = "reconnecting..."; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); };
  };
  connect();

  if (admin) {
    const panel = $("#panel");
    const drawPanel = () => {
      panel.innerHTML = `<div class="row" style="flex-wrap:wrap">
        <div>Invite link: <span class="code">${esc(location.origin)}/j/${esc(code ?? "")}</span> <button id="copy">Copy</button> <button id="rot">Make a new link</button></div></div>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
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
