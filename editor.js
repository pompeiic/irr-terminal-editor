"use strict";
// Terminal editor for Incursion Red River. Terminals/*.json and Schema.json are written by Unreal
// (IRR menu > Terminals > Sync); Workflow.json is owned by this page and never read by Unreal.

const OWNER = "pompeiic";
const REPO = "irr-terminal-editor";
const BRANCH = "main";
const TOKEN_KEY = "irr_terminal_pat";
const SCHEMA_FILE = "Schema.json";
const WORKFLOW_FILE = "Workflow.json";
const TERMINALS_DIR = "Terminals";
const LOG_CAP = 5000;
const CMD_TAG_ROOT = "Mission.Terminal.Commands";
const TAG_CD = CMD_TAG_ROOT + ".ChangeDirectory";
const TAG_BACK = CMD_TAG_ROOT + ".GoBack";

// ---------------------------------------------------------------- state
let schema = null;
let terms = [];             // { file, doc, baseline, sha, isNew }
let deletedTerms = [];      // committed-but-unsynced new terminals removed here: { file, sha }
let cur = null;
let tab = "files";
let sel = null;             // { kind: "dir"|"file"|"cmd"|"user", d, f, i }
let workflow = { log: [] };
let ghUser = null;
let tagSet = new Set();
let search = "";
const collapsed = new Set();     // card paths the user folded
const expandedLists = new Set(); // object-list paths the user unfolded (they start folded)
const foldedDirs = new Set();    // lower-case folder names folded in the tree
let con = null;                  // console simulator state

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const leaf = tag => String(tag || "").split(".").pop();
const eqName = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const isText = v => v && typeof v === "object" && !Array.isArray(v) && "$text" in v;
const textOf = v => isText(v) ? v.$text : (typeof v === "string" ? v : "");
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
const btn = (label, onclick, cls, title) => el("button", { class: cls || "", onclick, title }, label);
const iconBtn = (label, onclick, title, danger) => el("button", { class: "icon" + (danger ? " danger" : ""), onclick: e => { e.stopPropagation(); onclick(); }, title }, label);

function status(msg, isErr) {
  const s = $("status");
  s.textContent = msg;
  s.className = isErr ? "err" : "ok";
  s.style.display = "block";
  clearTimeout(s._t);
  s._t = setTimeout(() => s.style.display = "none", 6000);
  return !isErr;
}
function relTime(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}

// Copied texts must not share a localization key with their source.
function stripTextKeys(v) {
  if (Array.isArray(v)) { v.forEach(stripTextKeys); return v; }
  if (v && typeof v === "object") {
    if (isText(v) && !v.$table) { delete v.$ns; delete v.$key; }
    Object.values(v).forEach(stripTextKeys);
  }
  return v;
}

// ---------------------------------------------------------------- schema access
const classInfo = path => schema.classes[path];
const structInfo = path => schema.structs[path];
function classLabel(path) {
  if (!path) return "None";
  const c = classInfo(path);
  return c ? (c.displayName || c.name) : path.split(/[./]/).pop().replace(/_C$/, "");
}
const className = path => classInfo(path)?.name || String(path || "").split(/[./]/).pop();
const family = base => schema.families[base] || [];
const rootFields = () => classInfo(schema.root).fields;
const findField = (fields, name) => fields.find(f => f.name === name);
function rootStruct(name) {
  const f = findField(rootFields(), name);
  return f && f.type.inner ? structInfo(f.type.inner.struct) : null;
}
function fileBase() {
  const f = findField(rootStruct("Directories")?.fields || [], "Files");
  return f ? f.type.inner.base : null;
}

function newInstance(path) {
  const c = classInfo(path);
  return Object.assign({ "$class": path }, clone(c?.defaults || {}));
}
function defaultFor(type) {
  switch (type.kind) {
    case "bool": return false;
    case "int": case "float": return 0;
    case "enum": return schema.enums[type.enum]?.values?.[0]?.name || "";
    case "text": return { "$text": "" };
    case "tags": case "set": return [];
    case "struct": return clone(structInfo(type.struct)?.defaults || {});
    case "instanced": return null;
    case "map": return {};
    case "array": return type.fixed ? Array.from({ length: type.fixed }, () => defaultFor(type.inner)) : [];
    default: return "";
  }
}
// Matching fields carry over when an object changes class.
function switchClass(old, path) {
  const n = newInstance(path);
  if (!old) return n;
  const oldFields = classInfo(old.$class)?.fields || [];
  for (const f of classInfo(path)?.fields || []) {
    const of = findField(oldFields, f.name);
    if (of && JSON.stringify(of.type) === JSON.stringify(f.type) && f.name in old) n[f.name] = clone(old[f.name]);
  }
  return n;
}

// ---------------------------------------------------------------- terminal model
const D = () => cur.doc.data;
function ensureLists(data) {
  for (const k of ["Directories", "Commands", "Users"]) if (!Array.isArray(data[k])) data[k] = [];
  for (const d of data.Directories) { if (!Array.isArray(d.Files)) d.Files = []; if (!Array.isArray(d.Requirements)) d.Requirements = []; }
}
const isDirty = t => t.isNew && !t.sha || JSON.stringify(t.doc.data) !== t.baseline || t.doc.name !== t.baseName;
function findDir(data, name) { return data.Directories.find(d => eqName(d.DirectoryName, name)); }
const isRootDir = d => !d.MotherDirectoryName;
function dirPath(data, d) {
  const parts = [];
  const seen = new Set();
  while (d && !seen.has(d)) {
    seen.add(d);
    if (isRootDir(d)) return d.DirectoryName + ":\\" + parts.reverse().join("\\");
    parts.push(d.DirectoryName);
    d = findDir(data, d.MotherDirectoryName);
  }
  return "?:\\" + parts.reverse().join("\\");
}
function descendants(data, name) {
  const out = [];
  const walk = n => {
    for (const d of data.Directories) {
      if (eqName(d.MotherDirectoryName, n) && !out.includes(d)) { out.push(d); walk(d.DirectoryName); }
    }
  };
  walk(name);
  return out;
}
function commandWords(c) { return [c.Keyword, ...(c.Aliases || [])].filter(Boolean); }
function findCommand(data, word) { return data.Commands.find(c => commandWords(c).some(w => eqName(w, word))); }
// Mirrors UIRRTerminalSetup::FindCommandForResponseTag.
function commandForTag(data, tag) {
  if (!tag) return null;
  return data.Commands.find(c => c.CommandTag === tag) || data.Commands.find(c => eqName(c.Keyword, leaf(tag))) || null;
}
function uniqueName(base, taken) {
  const lower = new Set(taken.map(s => String(s).toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has((base + i).toLowerCase())) return base + i;
}

// ---------------------------------------------------------------- validation (port of UIRRTerminalSetup::IsDataValid)
function validate(data) {
  const out = [];
  const err = (msg, target) => out.push({ lvl: "error", msg, target });
  const warn = (msg, target) => out.push({ lvl: "warn", msg, target });
  const nulls = (list, what, target) => { if ((list || []).some(s => !s)) warn(`${what} has an empty entry.`, target); };

  if (!data.ErrorSequence) err("Error sequence is not set — unknown commands would print nothing.", { kind: "settings" });
  if (data.bBootSequence && !(data.BootSequences || []).length) warn("Boot sequence is on but has no entries.", { kind: "settings" });
  nulls(data.BootSequences, "Boot sequences", { kind: "settings" });
  nulls(data.HackInterruptedSequences, "Hack interrupted sequences", { kind: "settings" });

  if (!data.Users.length) warn("No users — login cannot succeed.", { kind: "users" });
  const userNames = new Set();
  data.Users.forEach((u, i) => {
    const n = String(u.Name || "");
    if (!n) err(`User ${i + 1} has no name.`, { kind: "user", i });
    else if (userNames.has(n.toLowerCase())) err(`Duplicate user "${n}".`, { kind: "user", i });
    userNames.add(n.toLowerCase());
  });

  const words = new Map();
  const tags = new Map();
  data.Commands.forEach((c, i) => {
    const t = { kind: "cmd", i };
    const label = c.Keyword || `#${i + 1}`;
    if (!c.Keyword) err(`Command ${i + 1} has no keyword.`, t);
    (c.Aliases || []).forEach(a => { if (!a) warn(`Command "${label}" has an empty alias.`, t); });
    for (const w of commandWords(c)) {
      if (/\s/.test(w)) err(`"${w}" (command "${label}") contains a space — input is split at the first space.`, t);
      const k = w.toLowerCase();
      if (words.has(k)) err(`"${w}" is used by commands "${words.get(k)}" and "${label}".`, t);
      else words.set(k, label);
    }
    if (c.CommandTag) {
      if (tags.has(c.CommandTag)) err(`Commands "${tags.get(c.CommandTag)}" and "${label}" share tag ${leaf(c.CommandTag)}.`, t);
      else tags.set(c.CommandTag, label);
    }
    nulls(c.OnSuccessSequences, `Command "${label}" success sequences`, t);
    nulls(c.OnFailSequences, `Command "${label}" fail sequences`, t);
  });

  const roots = data.Directories.filter(isRootDir);
  if (!roots.length) err("No root folder (a folder without a parent).", { kind: "files" });
  if (roots.length > 1) err(`Several root folders: ${roots.map(r => r.DirectoryName || "?").join(", ")}.`, { kind: "files" });
  if (data.Directories.length > 1) {
    if (!commandForTag(data, TAG_CD)) warn("No command answers ChangeDirectory — players cannot enter folders.", { kind: "commands" });
    if (!commandForTag(data, TAG_BACK)) warn("No command answers GoBack — players cannot leave folders.", { kind: "commands" });
  }
  const dirNames = new Set();
  data.Directories.forEach((d, di) => {
    const t = { kind: "dir", d: di };
    const n = String(d.DirectoryName || "");
    if (!n) err(`Folder ${di + 1} has no name.`, t);
    else if (dirNames.has(n.toLowerCase())) err(`Duplicate folder "${n}".`, t);
    dirNames.add(n.toLowerCase());
    if (d.MotherDirectoryName) {
      if (!findDir(data, d.MotherDirectoryName)) err(`Folder "${n}" has missing parent "${d.MotherDirectoryName}".`, t);
      else {
        let p = findDir(data, d.MotherDirectoryName);
        const seen = new Set([d]);
        while (p && !isRootDir(p)) {
          if (seen.has(p)) { err(`Folder "${n}" is part of a parent loop.`, t); break; }
          seen.add(p);
          p = findDir(data, p.MotherDirectoryName);
        }
      }
    }
    (d.Requirements || []).forEach(r => { if (!r) warn(`Folder "${n}" has an empty requirement.`, t); });
    const fileNames = new Set();
    d.Files.forEach((f, fi) => {
      const ft = { kind: "file", d: di, f: fi };
      if (!f) { err(`Folder "${n}" has an empty file slot.`, t); return; }
      const fn = String(f.Name || "");
      if (!fn) err(`File ${fi + 1} in "${n}" has no name.`, ft);
      else if (fileNames.has(fn.toLowerCase())) err(`Duplicate file "${fn}" in "${n}".`, ft);
      fileNames.add(fn.toLowerCase());
      for (const [tag, resp] of Object.entries(f.Responses || {})) {
        if (!tag) { err(`File "${fn}" has a response without a tag.`, ft); continue; }
        if (!commandForTag(data, tag)) {
          const msg = `File "${fn}": no command answers ${leaf(tag)}.`;
          f.bAutoHack ? err(msg + " The auto hack cannot type it.", ft) : warn(msg, ft);
        }
        (resp?.Condition || []).forEach(c => { if (!c) warn(`File "${fn}" (${leaf(tag)}) has an empty condition.`, ft); });
        nulls(resp?.Sequences, `File "${fn}" (${leaf(tag)}) sequences`, ft);
      }
    });
  });

  // The Unreal import drops tags the project does not define.
  const unknown = new Set();
  const walk = (v, type) => {
    if (!type || v === null || v === undefined) return;
    if (type.kind === "tag") { if (v && !tagSet.has(v)) unknown.add(v); }
    else if (type.kind === "tags") (v || []).forEach(t => { if (t && !tagSet.has(t)) unknown.add(t); });
    else if (type.kind === "array" || type.kind === "set") (v || []).forEach(x => walk(x, type.inner));
    else if (type.kind === "map") for (const [k, x] of Object.entries(v || {})) { walk(k, type.key); walk(x, type.value); }
    else if (type.kind === "struct") walkFields(v, structInfo(type.struct)?.fields);
    else if (type.kind === "instanced") walkFields(v, classInfo(v.$class)?.fields);
  };
  const walkFields = (obj, fields) => (fields || []).forEach(f => walk(obj?.[f.name], f.type));
  walkFields(data, rootFields());
  unknown.forEach(t => warn(`Tag "${t}" is not defined in the project — Unreal will clear it on import.`, null));
  return out;
}

// ---------------------------------------------------------------- loading
function authHeaders(accept) {
  const h = { "Accept": accept || "application/vnd.github+json" };
  const token = $("token").value.trim();
  if (token) h.Authorization = "Bearer " + token;
  return h;
}
const apiUrl = path => `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

// The API answers with the current commit; GitHub Pages can lag a few minutes behind it.
async function fetchJson(path, sha) {
  try {
    const res = await fetch(apiUrl(path) + "?ref=" + BRANCH + "&t=" + Date.now(), { headers: authHeaders("application/vnd.github.raw+json"), cache: "no-store" });
    if (res.ok) return await res.json();
    if (res.status === 404) return null;
  } catch (e) { /* fall back to Pages */ }
  const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(path + ": " + res.status);
  return await res.json();
}
async function listTerminals() {
  try {
    const res = await fetch(apiUrl(TERMINALS_DIR) + "?ref=" + BRANCH + "&t=" + Date.now(), { headers: authHeaders(), cache: "no-store" });
    if (res.status === 404) return [];
    if (res.ok) return (await res.json()).filter(e => e.type === "file" && e.name.endsWith(".json")).map(e => ({ path: e.path, sha: e.sha }));
  } catch (e) { /* fall through */ }
  return null;
}

async function load() {
  $("mainWrap").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    schema = await fetchJson(SCHEMA_FILE);
    if (!schema) {
      $("mainWrap").innerHTML = `<div class="empty">No <code>Schema.json</code> yet.<br>Run <b>IRR → Terminals → Sync</b> in Unreal once to publish the terminals.</div>`;
      return;
    }
    tagSet = new Set(schema.tags || []);
    workflow = (await fetchJson(WORKFLOW_FILE)) || { log: [] };
    if (!Array.isArray(workflow.log)) workflow.log = [];
    let listing = await listTerminals();
    if (listing === null) {
      status("GitHub API unavailable (rate limit?) — paste a token and reload. Showing nothing.", true);
      listing = [];
    }
    terms = [];
    for (const e of listing) {
      const doc = await fetchJson(e.path);
      if (!doc || typeof doc.data !== "object") continue;
      ensureLists(doc.data);
      terms.push({ file: e.path, doc, baseline: JSON.stringify(doc.data), baseName: doc.name, sha: e.sha, isNew: !doc.sourceHash });
    }
    terms.sort((a, b) => a.doc.name.localeCompare(b.doc.name));
    const last = localStorage.getItem("irr_terminal_last");
    selectTerminal(terms.find(t => t.file === last) || terms[0] || null);
  } catch (e) {
    $("mainWrap").innerHTML = `<div class="empty">Loading failed: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- top-level render
function selectTerminal(t) {
  cur = t;
  sel = null;
  con = null;
  if (t) localStorage.setItem("irr_terminal_last", t.file);
  renderAll();
}
function renderAll() {
  renderSidebar();
  renderBadge();
  renderToolbar();
  renderMain();
  renderPanel();
}
// Called after every edit: refresh everything except the editor the user is typing in.
function changed(where) {
  renderSidebar();
  renderBadge();
  renderTabs();
  renderProblems();
  if (where !== "main") renderMain(true);
  if (sel) renderPanelHead();
}

function renderSidebar() {
  const list = $("termList");
  list.innerHTML = "";
  if (!terms.length) list.append(el("div", { class: "hint", style: "padding:6px" }, "No terminals."));
  for (const t of terms) {
    const probs = validate(t.doc.data).filter(p => p.lvl === "error").length;
    list.append(el("div", { class: "side-item" + (t === cur ? " active" : ""), onclick: () => selectTerminal(t), title: t.file },
      el("span", { class: "nm" }, t.doc.name.replace(/^DA_Terminal_/, "")),
      t.isNew ? el("span", { class: "badge new", title: "Not in Unreal yet — created on the next sync" }, "NEW") : null,
      probs ? el("span", { class: "badge err", title: probs + " error(s)" }, probs) : null,
      isDirty(t) ? el("span", { class: "badge chg", title: "Unsaved changes" }, "●") : null));
  }
}
function renderBadge() {
  $("changesBadge").textContent = terms.filter(isDirty).length + deletedTerms.length;
}

const TABS = [
  ["files", "Files"], ["commands", "Commands"], ["users", "Users"], ["settings", "Settings"], ["console", "Console"], ["history", "History"]
];
function renderToolbar() {
  const head = $("termHead");
  head.innerHTML = "";
  if (!cur) { $("ttabs").innerHTML = ""; return; }
  head.append(el("span", { class: "nm" }, cur.doc.name),
    el("span", { class: "path" }, cur.doc.asset || `new — created as ${schema.newTerminalFolder || "?"}/${cur.doc.name}`));
  renderTabs();
}
function renderTabs() {
  const bar = $("ttabs");
  bar.innerHTML = "";
  if (!cur) return;
  const data = D();
  const counts = { files: data.Directories.reduce((n, d) => n + d.Files.length, 0), commands: data.Commands.length, users: data.Users.length };
  const probs = validate(data);
  const errsFor = kinds => probs.filter(p => p.lvl === "error" && p.target && kinds.includes(p.target.kind)).length;
  const errs = { files: errsFor(["files", "dir", "file"]), commands: errsFor(["commands", "cmd"]), users: errsFor(["users", "user"]), settings: errsFor(["settings"]) };
  for (const [id, label] of TABS) {
    bar.append(el("div", { class: "tab" + (tab === id ? " active" : ""), onclick: () => { tab = id; sel = null; search = ""; renderMain(); renderPanel(); renderTabs(); } },
      label,
      counts[id] !== undefined ? el("span", { class: "badge" }, counts[id]) : null,
      errs[id] ? el("span", { class: "badge err" }, errs[id]) : null));
  }
}
function renderProblems() {
  const box = $("problems");
  box.innerHTML = "";
  if (!cur || tab === "console" || tab === "history") return;
  for (const p of validate(D())) {
    box.append(el("div", { class: "prob " + p.lvl, onclick: () => p.target && goTo(p.target) },
      el("span", { class: "lvl" }, p.lvl === "error" ? "Error" : "Warning"), el("span", {}, p.msg)));
  }
}
function goTo(target) {
  const tabFor = { settings: "settings", users: "users", user: "users", commands: "commands", cmd: "commands", files: "files", dir: "files", file: "files" };
  tab = tabFor[target.kind] || tab;
  sel = ["dir", "file", "cmd", "user"].includes(target.kind) ? target : null;
  renderTabs();
  renderMain();
  renderPanel();
}

function renderMain(keepScroll) {
  const wrap = $("mainWrap");
  const top = wrap.scrollTop;
  wrap.innerHTML = "";
  wrap.style.overflow = "";
  $("subbar").innerHTML = "";
  renderProblems();
  if (!cur) {
    wrap.append(el("div", { class: "empty" }, schema ? "Pick a terminal on the left, or create one." : ""));
    return;
  }
  ({ files: renderFiles, commands: renderCommands, users: renderUsers, settings: renderSettings, console: renderConsole, history: renderHistory })[tab]();
  if (keepScroll) wrap.scrollTop = top;
}

function searchBox(placeholder) {
  const inp = el("input", { type: "text", placeholder, value: search });
  inp.oninput = () => { search = inp.value; renderMain(true); const n = $("subbar").querySelector("input"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  return inp;
}

// ---------------------------------------------------------------- files tab
function renderFiles() {
  const data = D();
  const sub = $("subbar");
  sub.append(searchBox("Search folders and files…"),
    btn("+ Folder", () => addFolder(selectedDirName())),
    btn("+ File", () => {
      const d = selectedDirIndex();
      if (d < 0) return status("Select a folder first.", true);
      addFile(d);
    }));

  const wrap = $("mainWrap");
  if (!data.Directories.length) {
    wrap.append(el("div", { class: "empty" }, "No folders yet. ", btn("+ Root folder", () => addFolder(""), "primary")));
    return;
  }
  const q = search.trim().toLowerCase();
  const matchDir = d => !q || String(d.DirectoryName).toLowerCase().includes(q) || d.Files.some(f => f && String(f.Name).toLowerCase().includes(q));
  const visibleDirs = new Set();
  if (q) {
    for (const d of data.Directories) if (matchDir(d)) {
      let p = d; const seen = new Set();
      while (p && !seen.has(p)) { seen.add(p); visibleDirs.add(p); p = p.MotherDirectoryName ? findDir(data, p.MotherDirectoryName) : null; }
    }
  }
  const placed = new Set();
  const row = (d, depth) => {
    if (placed.has(d)) return;
    placed.add(d);
    if (q && !visibleDirs.has(d)) return;
    const di = data.Directories.indexOf(d);
    const kids = data.Directories.filter(c => c !== d && eqName(c.MotherDirectoryName, d.DirectoryName));
    const folded = !q && foldedDirs.has(String(d.DirectoryName).toLowerCase());
    const reqs = (d.Requirements || []).filter(Boolean).length;
    wrap.append(el("div", { class: "tree-row dir" + (sel?.kind === "dir" && sel.d === di ? " active" : ""), style: `padding-left:${16 + depth * 20}px`, onclick: () => select({ kind: "dir", d: di }) },
      el("span", { class: "tw", onclick: e => { e.stopPropagation(); toggleFold(d); } }, kids.length || d.Files.length ? (folded ? "▸" : "▾") : ""),
      el("span", { class: "ic" }, isRootDir(d) ? "ROOT" : "DIR"),
      el("span", { class: "nm" }, d.DirectoryName || "(no name)"),
      reqs ? el("span", { class: "chip attn", title: "Entering runs " + reqs + " requirement(s)" }, "LOCKED") : null,
      el("span", { class: "grow" }),
      el("span", { class: "hint" }, d.Files.length + " file" + (d.Files.length === 1 ? "" : "s"))));
    if (folded) return;
    d.Files.forEach((f, fi) => {
      if (q && !(f && String(f.Name).toLowerCase().includes(q)) && !String(d.DirectoryName).toLowerCase().includes(q)) return;
      wrap.append(fileRow(d, di, f, fi, depth + 1));
    });
    kids.forEach(k => row(k, depth + 1));
  };
  data.Directories.filter(isRootDir).forEach(r => row(r, 0));
  const detached = data.Directories.filter(d => !placed.has(d));
  if (detached.length) {
    wrap.append(el("div", { class: "sec", style: "margin:18px 16px 0" }, "Detached — parent missing or looped"));
    detached.forEach(d => { if (!placed.has(d)) row(d, 0); });
  }
}
function fileRow(d, di, f, fi, depth) {
  const data = D();
  const tags = Object.keys(f?.Responses || {});
  return el("div", { class: "tree-row file" + (sel?.kind === "file" && sel.d === di && sel.f === fi ? " active" : ""), style: `padding-left:${16 + depth * 20}px`, onclick: () => select({ kind: "file", d: di, f: fi }) },
    el("span", { class: "tw" }),
    el("span", { class: "ic" }, "FILE"),
    el("span", { class: "nm" }, f ? (f.Name || "(no name)") : "(empty slot)"),
    el("span", { class: "chips" }, tags.map(t => {
      const c = commandForTag(data, t);
      return el("span", { class: "chip " + (c ? "acc" : "err"), title: c ? `typed as "${c.Keyword} ${f.Name}"` : "No command answers this tag" }, c ? c.Keyword : leaf(t));
    })),
    el("span", { class: "excerpt", title: fileExcerpt(f) }, fileExcerpt(f)),
    f && f.bAutoHack ? el("span", { class: "chip", title: "The terminal hack types these commands automatically" }, "AUTO HACK") : null,
    f && f.$class !== fileBase() ? el("span", { class: "hint" }, classLabel(f.$class)) : null);
}
function toggleFold(d) {
  const k = String(d.DirectoryName).toLowerCase();
  foldedDirs.has(k) ? foldedDirs.delete(k) : foldedDirs.add(k);
  renderMain(true);
}
function selectedDirIndex() {
  if (sel?.kind === "dir" || sel?.kind === "file") return sel.d;
  const roots = D().Directories.map((d, i) => [d, i]).filter(([d]) => isRootDir(d));
  return roots.length ? roots[0][1] : -1;
}
function selectedDirName() {
  const i = selectedDirIndex();
  return i >= 0 ? D().Directories[i].DirectoryName : "";
}
function addFolder(parent) {
  const data = D();
  const struct = rootStruct("Directories");
  if (!parent && data.Directories.some(isRootDir)) parent = data.Directories.find(isRootDir).DirectoryName;
  const d = Object.assign(clone(struct?.defaults || {}), {
    MotherDirectoryName: parent || "",
    DirectoryName: uniqueName(parent ? "Folder" : "C", data.Directories.map(x => x.DirectoryName)),
    Requirements: [], Files: []
  });
  data.Directories.push(d);
  if (parent) foldedDirs.delete(parent.toLowerCase());
  select({ kind: "dir", d: data.Directories.length - 1 });
  changed();
}
function addFile(di, path) {
  const dir = D().Directories[di];
  const f = newInstance(path || fileBase());
  f.Name = uniqueName("file.txt", dir.Files.filter(Boolean).map(x => x.Name));
  dir.Files.push(f);
  foldedDirs.delete(String(dir.DirectoryName).toLowerCase());
  select({ kind: "file", d: di, f: dir.Files.length - 1 });
  changed();
}
function renameDir(di, name) {
  const data = D();
  const d = data.Directories[di];
  name = name.trim();
  if (!name) return status("A folder needs a name.", true);
  if (data.Directories.some(x => x !== d && eqName(x.DirectoryName, name))) return status(`A folder "${name}" already exists — folder names are unique across the whole terminal.`, true);
  for (const c of data.Directories) if (c !== d && eqName(c.MotherDirectoryName, d.DirectoryName)) c.MotherDirectoryName = name;
  d.DirectoryName = name;
  changed();
  return true;
}
function deleteDir(di) {
  const data = D();
  const d = data.Directories[di];
  const sub = descendants(data, d.DirectoryName).filter(x => x !== d);
  const files = [d, ...sub].reduce((n, x) => n + x.Files.length, 0);
  if (!confirm(`Delete folder "${d.DirectoryName}"` + (sub.length ? `, ${sub.length} subfolder(s)` : "") + (files ? ` and ${files} file(s)` : "") + "?")) return;
  data.Directories = data.Directories.filter(x => x !== d && !sub.includes(x));
  sel = null;
  renderMain(true); renderPanel(); changed();
}

// ---------------------------------------------------------------- commands tab
function renderCommands() {
  const data = D();
  $("subbar").append(searchBox("Search commands…"), btn("+ Command", addCommand));
  const q = search.trim().toLowerCase();
  if (!data.Commands.length) { $("mainWrap").append(el("div", { class: "empty" }, "No commands.")); return; }
  const fileUses = tag => data.Directories.reduce((n, d) => n + d.Files.filter(f => f && f.Responses && tag in f.Responses).length, 0);
  const table = el("table", { class: "list" }, el("tr", {}, ["Keyword", "Aliases", "Tag", "Argument", "Success", "Fail"].map(h => el("th", {}, h))));
  data.Commands.forEach((c, i) => {
    if (q && !commandWords(c).some(w => w.toLowerCase().includes(q)) && !String(c.CommandTag).toLowerCase().includes(q)) return;
    const uses = c.CommandTag ? fileUses(c.CommandTag) : 0;
    table.append(el("tr", { class: "row" + (sel?.kind === "cmd" && sel.i === i ? " active" : ""), onclick: () => select({ kind: "cmd", i }) },
      el("td", { class: "nmc" }, c.Keyword || "(none)"),
      el("td", { class: "dim" }, (c.Aliases || []).join(", ")),
      el("td", {}, c.CommandTag ? el("span", { class: "chip acc", title: c.CommandTag + (uses ? ` — ${uses} file response(s)` : "") }, leaf(c.CommandTag)) : el("span", { class: "hint" }, "—")),
      el("td", { class: "dim" }, c.Argument ? classLabel(c.Argument.$class) : el("span", { class: "hint" }, "none")),
      el("td", { class: "faint" }, seqSummary(c.OnSuccessSequences)),
      el("td", { class: "faint" }, seqSummary(c.OnFailSequences))));
  });
  $("mainWrap").append(table);
}
function seqSummary(list) {
  list = list || [];
  if (!list.length) return "—";
  return list.map(s => s ? classLabel(s.$class) : "∅").join(", ");
}
function addCommand() {
  const data = D();
  const c = clone(rootStruct("Commands")?.defaults || {});
  c.Keyword = uniqueName("command", data.Commands.flatMap(commandWords));
  data.Commands.push(c);
  select({ kind: "cmd", i: data.Commands.length - 1 });
  changed();
}

// ---------------------------------------------------------------- users tab
function renderUsers() {
  const data = D();
  $("subbar").append(btn("+ User", () => {
    const u = clone(rootStruct("Users")?.defaults || {});
    u.Name = uniqueName("user", data.Users.map(x => x.Name));
    data.Users.push(u);
    select({ kind: "user", i: data.Users.length - 1 });
    changed();
  }), el("span", { class: "hint" }, "The first user is the one logged in when the terminal starts. Names and passwords are case-insensitive."));
  if (!data.Users.length) { $("mainWrap").append(el("div", { class: "empty" }, "No users.")); return; }
  const table = el("table", { class: "list" }, el("tr", {}, ["Name", "Password", "Tag", ""].map(h => el("th", {}, h))));
  data.Users.forEach((u, i) => table.append(el("tr", { class: "row" + (sel?.kind === "user" && sel.i === i ? " active" : ""), onclick: () => select({ kind: "user", i }) },
    el("td", { class: "nmc" }, u.Name || "(none)"),
    el("td", { class: "dim" }, u.Password || el("span", { class: "hint" }, "no password")),
    el("td", {}, u.Tag ? el("span", { class: "chip" }, leaf(u.Tag)) : el("span", { class: "hint" }, "—")),
    el("td", { class: "faint" }, i === 0 ? "default" : ""))));
  $("mainWrap").append(table);
}

// ---------------------------------------------------------------- settings tab
function renderSettings() {
  const body = el("div", { class: "pagebody" });
  const nameInp = el("input", { type: "text", value: cur.doc.name, readonly: !cur.isNew });
  nameInp.onchange = () => renameTerminal(nameInp.value);
  body.append(el("div", { class: "sec" }, "Asset"),
    el("label", {}, "Asset name"), nameInp,
    el("div", { class: "note" }, cur.isNew
      ? `Created as ${schema.newTerminalFolder || "?"}/${cur.doc.name} on the next Unreal sync. The name can change until then.`
      : `${cur.doc.asset} — rename or delete it in Unreal. To take it out of the web editor, turn off "Sync With Web Editor" on the asset (Web Editor category) and sync.`));
  const ctx = makeCtx("set", () => renderMain(true), "main");
  renderFields(body, D(), rootFields(), ctx, { skip: ["Users", "Directories", "Commands"], categories: true });
  if (cur.isNew) body.append(el("div", { class: "sec" }, "Danger"), btn("Delete terminal", deleteTerminal, "danger"));
  $("mainWrap").append(body);
}

// ---------------------------------------------------------------- history tab
function renderHistory() {
  const entries = workflow.log.filter(e => e.terminal === cur.file).slice().reverse();
  const wrap = $("mainWrap");
  if (!entries.length) { wrap.append(el("div", { class: "empty" }, "No edits from this page yet. Changes made in Unreal are not listed.")); return; }
  const hist = el("div", { class: "hist" });
  for (const e of entries.slice(0, 300)) {
    hist.append(el("div", { class: "hist-e" },
      el("div", {}, el("span", { class: "who" }, e.author || "unknown"), " ", el("span", { class: "when", title: e.time }, relTime(e.time))),
      el("div", { class: "lines" }, (e.lines || []).map(l => el("div", {}, l)))));
  }
  wrap.append(hist);
}

// ---------------------------------------------------------------- detail panel
function select(s) {
  sel = s;
  renderMain(true);
  renderPanel();
}
function selected() {
  if (!cur || !sel) return null;
  const data = D();
  if (sel.kind === "dir") return data.Directories[sel.d] || null;
  if (sel.kind === "file") {
    const files = data.Directories[sel.d]?.Files;
    return files && sel.f < files.length ? files[sel.f] : undefined;
  }
  if (sel.kind === "cmd") return data.Commands[sel.i] || null;
  if (sel.kind === "user") return data.Users[sel.i] || null;
  return null;
}
function renderPanelHead() {
  const head = $("panelHead");
  head.innerHTML = "";
  const obj = selected();
  if (obj === undefined || (!obj && sel?.kind !== "file")) return;
  const kinds = { dir: "Folder", file: "File", cmd: "Command", user: "User" };
  const name = sel.kind === "dir" ? obj.DirectoryName : sel.kind === "cmd" ? obj.Keyword : obj?.Name;
  const sub = sel.kind === "dir" ? dirPath(D(), obj) : sel.kind === "file" ? dirPath(D(), D().Directories[sel.d]) : sel.kind === "cmd" && obj.CommandTag ? obj.CommandTag : "";
  head.append(el("div", { class: "top" },
    el("div", {}, el("div", { class: "kind" }, kinds[sel.kind]), el("div", { class: "nm" }, name || "(no name)"), sub ? el("div", { class: "hint" }, sub) : null),
    el("span", { class: "close", onclick: () => { sel = null; renderMain(true); renderPanel(); } }, "✕")));
}
function renderPanel() {
  const panel = $("panel");
  const body = $("panelBody");
  const foot = $("panelFoot");
  const top = body.scrollTop;
  const obj = selected();
  if (!sel || obj === undefined || (!obj && sel.kind !== "file")) { panel.classList.remove("open"); sel = null; return; }
  panel.classList.add("open");
  renderPanelHead();
  body.innerHTML = "";
  foot.innerHTML = "";
  const ctx = makeCtx("p", () => renderPanel(), "panel");
  ({ dir: panelDir, file: panelFile, cmd: panelCommand, user: panelUser })[sel.kind](body, foot, obj, ctx);
  body.scrollTop = top;
}
function makeCtx(path, rerender, where) {
  return { path, rerender: () => { rerender(); changed(where); }, changed: () => changed(where) };
}

function panelDir(body, foot, d, ctx) {
  const data = D();
  const di = sel.d;
  const nameInp = el("input", { type: "text", value: d.DirectoryName });
  nameInp.onchange = () => { if (!renameDir(di, nameInp.value)) nameInp.value = d.DirectoryName; else renderPanel(); };
  const blocked = new Set([d, ...descendants(data, d.DirectoryName)]);
  const parentSel = el("select", {}, el("option", { value: "" }, "— none (root folder) —"),
    data.Directories.filter(x => !blocked.has(x)).map(x => el("option", { value: x.DirectoryName }, dirPath(data, x))));
  parentSel.value = findDir(data, d.MotherDirectoryName) ? findDir(data, d.MotherDirectoryName).DirectoryName : "";
  parentSel.onchange = () => { d.MotherDirectoryName = parentSel.value; renderPanel(); changed("panel"); };
  body.append(el("label", {}, "Name"), nameInp,
    el("div", { class: "note" }, "Typed as the path, e.g. ", el("code", {}, (commandForTag(data, TAG_CD)?.Keyword || "cd") + " " + (d.DirectoryName || "name")), ". Subfolders follow a rename."),
    el("label", {}, "Parent folder"), parentSel);
  if (d.MotherDirectoryName && !findDir(data, d.MotherDirectoryName)) body.append(el("div", { class: "note err" }, `Parent "${d.MotherDirectoryName}" does not exist.`));

  body.append(el("div", { class: "sec" }, "Entry requirements"),
    el("div", { class: "note" }, "All must pass to enter. Each one's success/failure sequences play instead of the command's."));
  const st = rootStruct("Directories");
  const reqField = findField(st?.fields || [], "Requirements");
  if (reqField) body.append(editor(d, "Requirements", reqField.type, reqField.meta || {}, { ...ctx, path: ctx.path + ".req" }));
  const rest = (st?.fields || []).filter(f => !["DirectoryName", "MotherDirectoryName", "Files", "Requirements"].includes(f.name));
  if (rest.length) renderFields(body, d, rest, ctx);

  body.append(el("div", { class: "sec" }, `Files (${d.Files.length})`));
  d.Files.forEach((f, fi) => body.append(el("div", { class: "arr-row" },
    el("div", { class: "grow" }, el("a", { href: "#", onclick: e => { e.preventDefault(); select({ kind: "file", d: di, f: fi }); } }, f ? f.Name || "(no name)" : "(empty slot)")),
    el("div", { class: "tools" },
      iconBtn("↑", () => { moveItem(d.Files, fi, -1); renderPanel(); changed("panel"); }, "Move up"),
      iconBtn("↓", () => { moveItem(d.Files, fi, 1); renderPanel(); changed("panel"); }, "Move down")))));
  body.append(addFileControl(di));
  foot.append(btn("Delete folder", () => deleteDir(di), "danger small"), el("span", { class: "spacer" }),
    btn("+ Subfolder", () => addFolder(d.DirectoryName), "small"));
}
function addFileControl(di) {
  const fam = family(fileBase());
  if (fam.length <= 1) return el("div", { class: "arr-add" }, btn("+ File", () => addFile(di), "small"));
  const s = el("select", {}, el("option", { value: "" }, "+ Add file…"), fam.map(p => el("option", { value: p }, classLabel(p))));
  s.onchange = () => s.value && addFile(di, s.value);
  return el("div", { class: "arr-add" }, s);
}

function panelFile(body, foot, f, ctx) {
  const data = D();
  const dir = data.Directories[sel.d];
  const fi = sel.f;
  const dirSel = el("select", {}, data.Directories.map((x, i) => el("option", { value: i }, dirPath(data, x))));
  dirSel.value = sel.d;
  dirSel.onchange = () => {
    const to = data.Directories[+dirSel.value];
    if (f && to.Files.some(x => x && eqName(x.Name, f.Name))) { dirSel.value = sel.d; return status(`"${to.DirectoryName}" already has a file "${f.Name}".`, true); }
    dir.Files.splice(fi, 1);
    to.Files.push(f);
    sel = { kind: "file", d: +dirSel.value, f: to.Files.length - 1 };
    renderMain(true); renderPanel(); changed();
  };
  body.append(el("label", {}, "Folder"), dirSel);
  if (!f) {
    body.append(el("div", { class: "note err" }, "This file slot is empty in Unreal."));
  } else {
    const fam = family(fileBase());
    if (fam.length > 1) {
      const cs = el("select", {}, fam.map(p => el("option", { value: p }, classLabel(p))));
      cs.value = f.$class;
      cs.onchange = () => { dir.Files[fi] = switchClass(f, cs.value); renderPanel(); changed("panel"); };
      body.append(el("label", {}, "File type"), cs);
    }
    const fields = classInfo(f.$class)?.fields || [];
    const respField = findField(fields, "Responses");
    renderFields(body, f, fields.filter(x => x !== respField), ctx, {
      nameCheck: (field, v) => field.name === "Name" && dir.Files.some(x => x && x !== f && eqName(x.Name, v)) ? `"${dir.DirectoryName}" already has a file "${v}".` : ""
    });
    const shown = Object.entries(f.Responses || {});
    if (shown.length) {
      body.append(el("div", { class: "sec" }, "On screen"));
      shown.forEach(([tag, resp]) => {
        const c = commandForTag(data, tag);
        const lines = responseLines(resp);
        body.append(el("div", { class: "hint" }, `> ${c ? c.Keyword : leaf(tag)} ${f.Name}${(resp?.Condition || []).filter(Boolean).length ? "   (if conditions pass)" : ""}`),
          el("div", { class: "screen" }, lines.length
            ? lines.map(l => el("div", { class: l.sys ? "sys" : "" }, l.text))
            : el("div", { class: "sys" }, "[no sequences — the command's own sequences play]")));
      });
    }
    if (respField) {
      body.append(el("div", { class: "sec" }, "Responses"),
        el("div", { class: "note" }, "One entry per command this file answers. The command's argument picks the entry by its tag; conditions must all pass, otherwise the argument's failure sequences play."));
      body.append(editor(f, "Responses", respField.type, respField.meta || {}, { ...ctx, path: ctx.path + ".resp", responses: true }));
    }
  }
  foot.append(btn("Delete file", () => {
    if (!confirm(`Delete file "${f?.Name || ""}"?`)) return;
    dir.Files.splice(fi, 1); sel = null; renderMain(true); renderPanel(); changed();
  }, "danger small"), el("span", { class: "spacer" }),
  f ? btn("Duplicate", () => {
    const c = stripTextKeys(clone(f));
    c.Name = uniqueName(f.Name, dir.Files.filter(Boolean).map(x => x.Name));
    dir.Files.splice(fi + 1, 0, c);
    select({ kind: "file", d: sel.d, f: fi + 1 }); changed();
  }, "small") : null);
}

function panelCommand(body, foot, c, ctx) {
  const data = D();
  const st = rootStruct("Commands");
  renderFields(body, c, st?.fields || [], ctx, {
    nameCheck: (field, v) => {
      if (field.name !== "Keyword" || !v) return "";
      const other = data.Commands.find(x => x !== c && commandWords(x).some(w => eqName(w, v)));
      return other ? `"${v}" is already used by "${other.Keyword}".` : /\s/.test(v) ? "No spaces — input is split at the first space." : "";
    }
  });
  if (c.CommandTag) {
    const users = [];
    data.Directories.forEach(d => d.Files.forEach(f => { if (f && f.Responses && c.CommandTag in f.Responses) users.push(dirPath(data, d) + "\\" + f.Name); }));
    body.append(el("div", { class: "sec" }, `Files answering ${leaf(c.CommandTag)} (${users.length})`),
      users.length ? el("div", { class: "note" }, users.map(u => el("div", {}, u))) : el("div", { class: "note" }, "None."));
  }
  const i = sel.i;
  foot.append(btn("Delete", () => { if (!confirm(`Delete command "${c.Keyword}"?`)) return; data.Commands.splice(i, 1); sel = null; renderMain(true); renderPanel(); changed(); }, "danger small"),
    el("span", { class: "spacer" }),
    btn("↑", () => { if (moveItem(data.Commands, i, -1)) sel.i--; renderMain(true); changed(); }, "small"),
    btn("↓", () => { if (moveItem(data.Commands, i, 1)) sel.i++; renderMain(true); changed(); }, "small"),
    btn("Duplicate", () => {
      const n = stripTextKeys(clone(c));
      n.Keyword = uniqueName(c.Keyword || "command", data.Commands.flatMap(commandWords));
      n.Aliases = []; n.CommandTag = "";
      data.Commands.splice(i + 1, 0, n); select({ kind: "cmd", i: i + 1 }); changed();
    }, "small"));
}
function panelUser(body, foot, u, ctx) {
  const data = D();
  renderFields(body, u, rootStruct("Users")?.fields || [], ctx, {
    nameCheck: (field, v) => field.name === "Name" && data.Users.some(x => x !== u && eqName(x.Name, v)) ? `User "${v}" already exists.` : ""
  });
  const loginCmd = commandForTag(data, CMD_TAG_ROOT + ".Login");
  body.append(el("div", { class: "note" }, "Log in with ", el("code", {}, `${loginCmd?.Keyword || "login"} ${u.Name || "name"} ${u.Password || "password"}`)));
  const i = sel.i;
  foot.append(btn("Delete", () => { data.Users.splice(i, 1); sel = null; renderMain(true); renderPanel(); changed(); }, "danger small"),
    el("span", { class: "spacer" }),
    btn("↑", () => { if (moveItem(data.Users, i, -1)) sel.i--; renderMain(true); renderPanel(); changed(); }, "small"),
    btn("↓", () => { if (moveItem(data.Users, i, 1)) sel.i++; renderMain(true); renderPanel(); changed(); }, "small"));
}
function moveItem(arr, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

// ---------------------------------------------------------------- generic schema-driven form
function evalCondition(obj, expr) {
  const m = /^\s*(!?)\s*([A-Za-z_]\w*)\s*(?:(==|!=)\s*([\w:.]+))?\s*$/.exec(expr || "");
  if (!m || !(m[2] in obj)) return true;
  let v = obj[m[2]];
  if (m[3]) {
    const rhs = m[4].split("::").pop();
    const eq = String(v) === rhs || (rhs === "true" && v === true) || (rhs === "false" && v === false);
    v = m[3] === "==" ? eq : !eq;
  } else v = !!v;
  return m[1] ? !v : v;
}
function renderFields(container, obj, fields, ctx, opts = {}) {
  const skip = new Set(opts.skip || []);
  const toggles = new Set(fields.filter(f => f.meta?.InlineEditConditionToggle).map(f => f.name));
  const visible = fields.filter(f => !skip.has(f.name) && !toggles.has(f.name));
  const normal = visible.filter(f => !f.meta?.AdvancedDisplay);
  const adv = visible.filter(f => f.meta?.AdvancedDisplay);
  let lastCat = null;
  for (const f of normal) {
    if (opts.categories && f.category !== lastCat) {
      lastCat = f.category;
      container.append(el("div", { class: "sec" }, String(f.category || "General").split("|").pop()));
    }
    const row = fieldRow(obj, f, ctx, opts, toggles);
    if (row) container.append(row);
  }
  if (adv.length) {
    const d = el("details", { class: "adv" }, el("summary", {}, "Advanced"));
    for (const f of adv) { const row = fieldRow(obj, f, ctx, opts, toggles); if (row) d.append(row); }
    container.append(d);
  }
}
function fieldRow(obj, f, ctx, opts, toggles) {
  const meta = f.meta || {};
  const cond = meta.EditCondition;
  const enabled = !cond || evalCondition(obj, cond);
  if (!enabled && meta.EditConditionHides) return null;
  const c = { ...ctx, path: ctx.path + "." + f.name };
  if (!(f.name in obj)) obj[f.name] = defaultFor(f.type);
  if (f.type.kind === "bool") {
    const cb = el("input", { type: "checkbox", checked: obj[f.name] });
    cb.onchange = () => { obj[f.name] = cb.checked; ctx.rerender(); };
    return el("div", { class: "field" + (enabled ? "" : " disabled") }, el("label", { class: "chk", title: f.tooltip }, cb, f.label));
  }
  const labelEl = el("label", { title: f.tooltip }, f.label);
  // An inline toggle lives in the label of the field it gates.
  const toggleName = cond && toggles.has(cond.replace(/^!/, "").trim()) ? cond.replace(/^!/, "").trim() : null;
  if (toggleName) {
    const cb = el("input", { type: "checkbox", checked: !!obj[toggleName] });
    cb.onchange = () => { obj[toggleName] = cb.checked; ctx.rerender(); };
    labelEl.classList.add("chk");
    labelEl.prepend(cb);
  }
  const wrap = el("div", { class: "field" + (enabled || toggleName ? "" : " disabled") }, labelEl);
  const ed = editor(obj, f.name, f.type, meta, c, null, opts.nameCheck ? v => opts.nameCheck(f, v) : null);
  if (toggleName && !enabled) ed.classList.add("disabled"), ed.style.opacity = ".45", ed.style.pointerEvents = "none";
  wrap.append(ed);
  return wrap;
}

function editor(holder, key, type, meta, ctx, tools, check) {
  switch (type.kind) {
    case "bool": {
      const cb = el("input", { type: "checkbox", checked: holder[key] });
      cb.onchange = () => { holder[key] = cb.checked; ctx.changed(); };
      return el("div", {}, cb);
    }
    case "int": case "float": {
      const inp = el("input", { type: "number", step: type.kind === "int" ? "1" : "any", value: holder[key] ?? 0 });
      const read = () => {
        let v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return null;
        if (type.kind === "int") v = Math.round(v);
        return v;
      };
      inp.oninput = () => { const v = read(); if (v !== null) { holder[key] = v; ctx.changed(); } };
      inp.onchange = () => {
        let v = read() ?? 0;
        if (meta.ClampMin !== undefined && v < +meta.ClampMin) v = +meta.ClampMin;
        if (meta.ClampMax !== undefined && v > +meta.ClampMax) v = +meta.ClampMax;
        holder[key] = v; inp.value = v; ctx.changed();
      };
      return inp;
    }
    case "enum": {
      const values = schema.enums[type.enum]?.values || [];
      const s = el("select", {}, values.map(v => el("option", { value: v.name }, v.label || v.name)));
      s.value = holder[key];
      s.onchange = () => { holder[key] = s.value; ctx.rerender(); };
      return s;
    }
    case "name": case "string": {
      const inp = el("input", { type: "text", value: holder[key] ?? "" });
      const note = el("div", { class: "note err" });
      const run = () => { const m = check ? check(inp.value) : ""; note.textContent = m; note.style.display = m ? "" : "none"; inp.classList.toggle("invalid", !!m); };
      inp.oninput = () => { holder[key] = inp.value; run(); ctx.changed(); };
      run();
      return check ? el("div", {}, inp, note) : inp;
    }
    case "text": return textEditor(holder, key, meta, ctx);
    case "tag": return tagEditor(holder, key, meta, ctx);
    case "tags": return tagsEditor(holder, key, meta, ctx);
    case "struct": {
      if (!holder[key] || typeof holder[key] !== "object") holder[key] = defaultFor(type);
      const info = structInfo(type.struct);
      return foldCard(ctx.path, el("span", { class: "ttl" }, info?.displayName || info?.name || "Struct"), structPreview(holder[key], info), tools,
        b => renderFields(b, holder[key], info?.fields || [], ctx));
    }
    case "instanced": return instancedEditor(holder, key, type, ctx, tools);
    case "asset": {
      const choices = schema.assetChoices?.[type.class] || [];
      if (!choices.length) {
        const inp = el("input", { type: "text", value: holder[key] || "", placeholder: "/Game/... asset path" });
        inp.onchange = () => { holder[key] = inp.value.trim(); ctx.changed(); };
        return inp;
      }
      return pathSelect(holder, key, choices.map(p => ({ path: p, name: p.split("/").pop().split(".").pop() })), ctx);
    }
    case "class": return pathSelect(holder, key, schema.classChoices?.[type.base] || [], ctx);
    case "array": case "set": return arrayEditor(holder, key, type, meta, ctx);
    case "map": return mapEditor(holder, key, type, meta, ctx);
    default: return el("div", { class: "hint" }, `(${type.kind} — edit in Unreal)`);
  }
}
function pathSelect(holder, key, choices, ctx) {
  const s = el("select", {}, el("option", { value: "" }, "None"), choices.map(c => el("option", { value: c.path, title: c.path }, c.name)));
  if (holder[key] && !choices.some(c => c.path === holder[key])) s.append(el("option", { value: holder[key] }, holder[key].split("/").pop()));
  s.value = holder[key] || "";
  s.onchange = () => { holder[key] = s.value; ctx.changed(); };
  return s;
}
function textEditor(holder, key, meta, ctx) {
  let t = holder[key];
  if (!isText(t)) { t = { "$text": String(t ?? "") }; holder[key] = t; }
  const multi = !!meta.MultiLine;
  const inp = el(multi ? "textarea" : "input", multi ? { class: t.$text.split("\n").length > 4 ? "tall" : "" } : { type: "text" });
  inp.value = t.$text;
  if (t.$table) { inp.readOnly = true; return el("div", {}, inp, el("div", { class: "note" }, `From string table ${t.$table} — edit it in Unreal.`)); }
  inp.oninput = () => { t.$text = inp.value; ctx.changed(); };
  const hint = t.$invariant ? "Not localized." : t.$key ? "" : t.$text ? "Gets a localization key on the next sync." : "";
  return hint ? el("div", {}, inp, el("div", { class: "note" }, hint)) : inp;
}
const datalists = new Map();
function datalistFor(categories) {
  const key = categories || "*";
  if (datalists.has(key)) return datalists.get(key);
  const roots = (categories || "").split(",").map(s => s.trim()).filter(Boolean);
  const id = "dl" + datalists.size;
  const list = el("datalist", { id }, [...tagSet].filter(t => !roots.length || roots.some(r => t === r || t.startsWith(r + "."))).map(t => el("option", { value: t })));
  document.body.append(list);
  datalists.set(key, id);
  return id;
}
function tagNote(tag) {
  if (!tag) return null;
  if (!tagSet.has(tag)) return el("div", { class: "note err" }, "Not a project tag — Unreal clears it on import.");
  if (!tag.startsWith(CMD_TAG_ROOT + ".") || !cur) return null;
  const c = commandForTag(D(), tag);
  return c ? el("div", { class: "note ok" }, "Typed as ", el("code", {}, c.Keyword)) : el("div", { class: "note warn" }, "No command answers this tag yet.");
}
function tagEditor(holder, key, meta, ctx) {
  const inp = el("input", { type: "text", value: holder[key] || "", list: datalistFor(meta.Categories), placeholder: meta.Categories ? meta.Categories + "…" : "Gameplay tag" });
  const box = el("div", {}, inp);
  let note = tagNote(holder[key]);
  if (note) box.append(note);
  inp.oninput = () => {
    holder[key] = inp.value.trim();
    inp.classList.toggle("invalid", !!holder[key] && !tagSet.has(holder[key]));
    const n = tagNote(holder[key]);
    if (note) note.remove();
    note = n;
    if (n) box.append(n);
    ctx.changed();
  };
  inp.classList.toggle("invalid", !!holder[key] && !tagSet.has(holder[key]));
  return box;
}
function tagsEditor(holder, key, meta, ctx) {
  if (!Array.isArray(holder[key])) holder[key] = [];
  const list = holder[key];
  const box = el("div", {});
  const chips = el("div", { class: "chips", style: "margin-bottom:5px" }, list.map((t, i) => el("span", { class: "chip " + (tagSet.has(t) ? "acc" : "err"), title: t }, leaf(t), " ",
    el("a", { href: "#", style: "color:inherit", onclick: e => { e.preventDefault(); list.splice(i, 1); ctx.rerender(); } }, "×"))));
  const inp = el("input", { type: "text", list: datalistFor(meta.Categories), placeholder: "Add tag…" });
  inp.onchange = () => { const v = inp.value.trim(); if (v && !list.includes(v)) { list.push(v); ctx.rerender(); } };
  box.append(chips, inp);
  return box;
}

function foldCard(path, title, preview, tools, fill, extraClass) {
  const open = !collapsed.has(path);
  const card = el("div", { class: "card" + (open ? " open" : "") + (extraClass ? " " + extraClass : "") });
  const tg = el("span", { class: "tg" }, fill ? (open ? "▾" : "▸") : "");
  const head = el("div", { class: "card-h" }, tg, title, !open && preview ? el("span", { class: "pv" }, preview) : null, tools);
  card.append(head);
  if (fill) {
    tg.onclick = () => { open ? collapsed.add(path) : collapsed.delete(path); const n = foldCard(path, title, preview, tools, fill, extraClass); card.replaceWith(n); };
    if (open) { const b = el("div", { class: "card-b" }); fill(b); card.append(b); }
  }
  return card;
}
function objPreview(obj) {
  if (!obj) return "";
  for (const f of classInfo(obj.$class)?.fields || []) {
    const v = obj[f.name];
    if (f.type.kind === "text" && textOf(v)) return textOf(v).replace(/\s+/g, " ");
    if ((f.type.kind === "string" || f.type.kind === "name") && v) return String(v);
    if (f.type.kind === "tag" && v) return leaf(v);
    if (f.type.kind === "tags" && Array.isArray(v) && v.length) return v.map(leaf).join(", ");
  }
  return "";
}
function structPreview(obj, info) {
  if (!obj || !info) return "";
  for (const f of info.fields) {
    const v = obj[f.name];
    if (f.type.kind === "text" && textOf(v)) return textOf(v);
    if (["string", "name"].includes(f.type.kind) && v) return String(v);
    if (f.type.kind === "array" && Array.isArray(v) && v.length) return `${v.length} ${f.label.toLowerCase()}`;
  }
  return "";
}
function instancedEditor(holder, key, type, ctx, tools) {
  const val = holder[key];
  const fam = family(type.base);
  const s = el("select", { onclick: e => e.stopPropagation() }, el("option", { value: "" }, "— None —"), fam.map(p => el("option", { value: p }, classLabel(p))));
  if (val && !fam.includes(val.$class)) s.append(el("option", { value: val.$class }, classLabel(val.$class)));
  s.value = val ? val.$class : "";
  s.onchange = () => { holder[key] = s.value ? switchClass(val, s.value) : null; collapsed.delete(ctx.path); ctx.rerender(); };
  if (!val) return foldCard(ctx.path, s, "", tools, null, "none");
  const info = classInfo(val.$class);
  return foldCard(ctx.path, s, objPreview(val), tools, b => {
    if (!info) { b.append(el("div", { class: "note warn" }, "This class is not in the schema — run a sync in Unreal."), el("div", { class: "raw" }, JSON.stringify(val, null, 2))); return; }
    if (info.tooltip && info.tooltip !== info.name) b.append(el("div", { class: "note" }, info.tooltip));
    if (!info.fields.length) b.append(el("div", { class: "note" }, "No editable settings."));
    // The object's own settings first; nested object lists (feedback sequences, events) fold up below them.
    const lists = info.fields.filter(isObjectList);
    renderFields(b, val, info.fields.filter(f => !isObjectList(f)), ctx);
    for (const f of lists) b.append(objectListFold(val, f, ctx));
  });
}
function isObjectList(f) {
  return (f.type.kind === "array" || f.type.kind === "set") && f.type.inner?.kind === "instanced" && !f.meta?.AdvancedDisplay;
}
function objectListFold(obj, f, ctx) {
  const path = ctx.path + "." + f.name;
  if (!Array.isArray(obj[f.name])) obj[f.name] = defaultFor(f.type);
  const items = obj[f.name].filter(Boolean);
  const d = el("details", { class: "sub" });
  d.open = expandedLists.has(path);
  d.ontoggle = () => { d.open ? expandedLists.add(path) : expandedLists.delete(path); };
  d.append(el("summary", { title: f.tooltip },
    el("span", {}, f.label), el("span", { class: "n" }, `(${items.length})`),
    el("span", { class: "pv" }, items.map(objPreview).filter(Boolean).join(" · "))));
  d.append(el("div", { class: "sub-b" }, editor(obj, f.name, f.type, f.meta || {}, { ...ctx, path })));
  return d;
}

function arrayEditor(holder, key, type, meta, ctx) {
  if (!Array.isArray(holder[key])) holder[key] = defaultFor(type);
  const arr = holder[key];
  const inner = type.inner;
  const isSet = type.kind === "set";
  const box = el("div", { class: "arr" });
  const complex = ["struct", "instanced", "map", "array"].includes(inner.kind);
  arr.forEach((_, i) => {
    const t = el("div", { class: "tools" });
    if (!type.fixed) {
      if (!isSet) {
        t.append(iconBtn("↑", () => { moveItem(arr, i, -1); ctx.rerender(); }, "Move up"),
          iconBtn("↓", () => { moveItem(arr, i, 1); ctx.rerender(); }, "Move down"),
          iconBtn("⧉", () => { arr.splice(i + 1, 0, stripTextKeys(clone(arr[i]))); ctx.rerender(); }, "Duplicate"));
      }
      t.append(iconBtn("✕", () => { arr.splice(i, 1); ctx.rerender(); }, "Remove", true));
    }
    const sub = { ...ctx, path: ctx.path + "[" + i + "]" };
    if (complex) box.append(editor(arr, i, inner, meta, sub, t));
    else box.append(el("div", { class: "arr-row" }, el("div", { class: "grow" }, editor(arr, i, inner, meta, sub)), t));
  });
  if (!type.fixed) {
    if (inner.kind === "instanced") {
      const fam = family(inner.base);
      if (fam.length === 1) box.append(el("div", { class: "arr-add" }, btn("+ " + classLabel(fam[0]), () => { arr.push(newInstance(fam[0])); ctx.rerender(); }, "small")));
      else {
        const s = el("select", {}, el("option", { value: "" }, "+ Add…"), fam.map(p => el("option", { value: p }, classLabel(p))));
        s.onchange = () => { if (s.value) { arr.push(newInstance(s.value)); ctx.rerender(); } };
        box.append(el("div", { class: "arr-add" }, s));
      }
    } else {
      box.append(el("div", { class: "arr-add" }, btn("+ Add", () => {
        const v = defaultFor(inner);
        if (isSet && arr.some(x => JSON.stringify(x) === JSON.stringify(v))) return status("That value is already in the set.", true);
        arr.push(v); ctx.rerender();
      }, "small")));
    }
  }
  if (!arr.length && type.fixed === undefined) box.prepend(el("div", { class: "hint", style: "padding-top:4px" }, "Empty."));
  return box;
}
function renameKey(map, oldKey, newKey) {
  const entries = Object.entries(map);
  for (const k of Object.keys(map)) delete map[k];
  for (const [k, v] of entries) map[k === oldKey ? newKey : k] = v;
}
function keyInput(type, value, meta, onCommit) {
  if (type.kind === "enum") {
    const s = el("select", {}, (schema.enums[type.enum]?.values || []).map(v => el("option", { value: v.name }, v.label || v.name)));
    s.value = value; s.onchange = () => onCommit(s.value);
    return s;
  }
  const isTag = type.kind === "tag";
  const inp = el("input", { type: isTag || type.kind !== "int" ? "text" : "number", value, list: isTag ? datalistFor(meta.Categories || (ctxResponses ? CMD_TAG_ROOT : "")) : null, placeholder: isTag ? "Tag" : "Key" });
  inp.onchange = () => onCommit(inp.value.trim());
  if (isTag) inp.classList.toggle("invalid", !!value && !tagSet.has(value));
  return inp;
}
let ctxResponses = false;
function mapEditor(holder, key, type, meta, ctx) {
  if (!holder[key] || typeof holder[key] !== "object" || Array.isArray(holder[key])) holder[key] = {};
  const map = holder[key];
  const box = el("div", { class: "arr" });
  ctxResponses = !!ctx.responses;
  const commitKey = (oldKey, nk) => {
    if (nk === oldKey) return;
    if (!nk) return status("A key cannot be empty.", true);
    if (nk in map) { ctx.rerender(); return status(`"${leaf(nk)}" is already in the list.`, true); }
    renameKey(map, oldKey, nk);
    ctx.rerender();
  };
  for (const k of Object.keys(map)) {
    const path = ctx.path + "{" + k + "}";
    const kin = el("div", { class: "mapkey", onclick: e => e.stopPropagation() }, keyInput(type.key, k, meta, nk => commitKey(k, nk)));
    const t = el("div", { class: "tools" }, iconBtn("✕", () => { delete map[k]; ctx.rerender(); }, "Remove", true));
    const valueKind = type.value.kind;
    if (valueKind === "struct" && (!map[k] || typeof map[k] !== "object")) map[k] = defaultFor(type.value);
    if (["struct", "instanced", "map", "array"].includes(valueKind)) {
      const isResp = ctx.responses && type.key.kind === "tag";
      box.append(foldCard(path, kin, "", t, b => {
        if (isResp) { const n = tagNote(k); if (n) b.append(n); }
        if (valueKind === "struct") renderFields(b, map[k], structInfo(type.value.struct)?.fields || [], { ...ctx, path });
        else b.append(editor(map, k, type.value, {}, { ...ctx, path }));
      }));
    } else {
      box.append(el("div", { class: "arr-row" }, kin, el("div", { class: "grow" }, editor(map, k, type.value, {}, { ...ctx, path })), t));
    }
  }
  const add = keyInput(type.key, "", meta, () => {});
  add.onchange = null;
  const addBtn = btn("+ Add", () => {
    const nk = add.value.trim();
    if (!nk) return status("Enter a key first.", true);
    if (nk in map) return status(`"${leaf(nk)}" is already in the list.`, true);
    map[nk] = defaultFor(type.value);
    ctx.rerender();
  }, "small");
  if (ctx.responses) add.placeholder = "Command tag, e.g. " + CMD_TAG_ROOT + ".Read";
  box.append(el("div", { class: "arr-add" }, add, addBtn));
  if (ctx.responses && cur) {
    const free = D().Commands.filter(c => c.CommandTag && !(c.CommandTag in map));
    if (free.length) box.append(el("div", { class: "chips", style: "margin-top:6px" }, el("span", { class: "hint" }, "Quick add:"),
      free.map(c => el("a", { href: "#", class: "chip acc", onclick: e => { e.preventDefault(); map[c.CommandTag] = defaultFor(type.value); ctx.rerender(); } }, "+ " + c.Keyword))));
  }
  return box;
}

// ---------------------------------------------------------------- console simulator
function newConsole() {
  const data = D();
  const root = data.Directories.find(isRootDir);
  return { dir: root ? root.DirectoryName : "", user: data.Users[0]?.Name || "", lines: [], reqPass: true, condPass: true, history: [], hi: 0 };
}
function conPrint(text, cls) { con.lines.push({ text, cls }); }
function conDir() { return findDir(D(), con.dir); }
function conPrompt() { const d = conDir(); return (con.user ? con.user + "@" : "") + (d ? dirPath(D(), d) : "?") + ">"; }
function printSequences(seqs, vars) {
  const data = D();
  for (const s of seqs || []) {
    if (!s) { conPrint("[empty sequence slot]", "sys"); continue; }
    const name = className(s.$class);
    if (/Dir$|_Dir|Directory/i.test(name) && !/Change/i.test(name)) {
      const d = conDir();
      if (d) {
        data.Directories.filter(x => eqName(x.MotherDirectoryName, d.DirectoryName)).forEach(x => conPrint("  <DIR>  " + x.DirectoryName));
        d.Files.filter(Boolean).forEach(f => conPrint("         " + f.Name));
      }
    } else if (/Help/i.test(name)) {
      data.Commands.forEach(c => conPrint("  " + c.Keyword + ((c.Aliases || []).length ? "  (" + c.Aliases.join(", ") + ")" : "")));
    } else {
      let text = objPreviewFull(s);
      for (const [k, v] of Object.entries(vars || {})) text = text.split("{" + k + "}").join(v);
      conPrint(text || `[${classLabel(s.$class)}]`, text ? "" : "sys");
    }
    const events = (s.Events || []).filter(Boolean);
    if (events.length) conPrint("  ⚡ " + events.map(e => classLabel(e.$class)).join(", "), "evt");
  }
}
function objPreviewFull(obj) {
  for (const f of classInfo(obj.$class)?.fields || []) {
    const v = obj[f.name];
    if (f.type.kind === "text" && textOf(v)) return textOf(v);
    if (f.type.kind === "string" && v) return v;
  }
  return "";
}
// What a response prints, sequence by sequence; listing/help sequences have no text of their own.
function responseLines(resp) {
  return (resp?.Sequences || []).map(s => {
    if (!s) return { sys: true, text: "[empty sequence slot]" };
    const text = objPreviewFull(s);
    return text ? { text } : { sys: true, text: `[${classLabel(s.$class)}]` };
  });
}
function fileExcerpt(f) {
  for (const resp of Object.values(f?.Responses || {})) {
    const hit = responseLines(resp).find(l => !l.sys);
    if (hit) return hit.text.replace(/\s+/g, " ").trim();
  }
  return "";
}
function argumentSequences(arg, ok) { return (ok ? arg.OnSuccessSequences : arg.OnFailureSequences) || []; }
// Mirrors UIRRTerminalComponent::TryChangeDirectory: absolute from the root, else relative to the current folder.
function simulateCd(path) {
  const data = D();
  const parts = path.split(/[\\/]+/).filter(Boolean).map(p => p.replace(/:$/, ""));
  if (!parts.length) return { ok: false, seqs: [] };
  const walk = (start, rest) => {
    let d = start, seqs = [];
    for (const p of rest) {
      const next = findDir(data, p);
      if (!next || !eqName(next.MotherDirectoryName, d.DirectoryName)) return null;
      const reqs = (next.Requirements || []).filter(Boolean);
      if (reqs.length) {
        seqs = con.reqPass ? reqs.flatMap(r => r.OnSuccessSequences || []) : (reqs[0].OnFailureSequences || []);
        if (!con.reqPass) return { ok: false, seqs };
      }
      d = next;
    }
    return { ok: true, seqs, dir: d };
  };
  const root = data.Directories.find(isRootDir);
  let r = root && eqName(parts[0], root.DirectoryName) ? walk(root, parts.slice(1)) : null;
  if (!r || !r.ok) { const rel = conDir() ? walk(conDir(), parts) : null; if (rel && (rel.ok || !r)) r = rel; }
  if (!r) return { ok: false, seqs: [] };
  if (r.ok) con.dir = r.dir.DirectoryName;
  return r;
}
function runConsole(input) {
  const data = D();
  conPrint(conPrompt() + " " + input, "echo");
  const at = input.indexOf(" ");
  const word = at < 0 ? input : input.slice(0, at);
  const rest = at < 0 ? "" : input.slice(at + 1);
  const cmd = findCommand(data, word);
  if (!cmd) { printSequences(data.ErrorSequence ? [data.ErrorSequence] : []); if (!data.ErrorSequence) conPrint("[no error sequence set]", "err"); return; }
  let ok = rest === "";
  let seqs = [];
  let vars = {};
  const arg = cmd.Argument;
  if (arg) {
    const an = className(arg.$class);
    if (/ChangeDirectory/.test(an)) {
      const r = simulateCd(rest);
      ok = r.ok;
      seqs = r.seqs.length ? r.seqs : argumentSequences(arg, ok);
    } else if (/GoBack/.test(an)) {
      const d = conDir();
      ok = !!d && !isRootDir(d) && !!findDir(data, d.MotherDirectoryName);
      if (ok) con.dir = findDir(data, d.MotherDirectoryName).DirectoryName;
      seqs = argumentSequences(arg, ok);
    } else if (/FileCommand/.test(an)) {
      const f = conDir()?.Files.find(x => x && eqName(x.Name, rest.trim()));
      const resp = f?.Responses?.[arg.Tag];
      const conds = (resp?.Condition || []).filter(Boolean);
      ok = !!resp && (con.condPass || !conds.length);
      vars = { file: rest.trim() };
      if (ok) seqs = resp.Sequences || [];
      else if ((arg.OnFailureSequences || []).length) seqs = arg.OnFailureSequences;
      else if (textOf(arg.OnFailText)) { conPrint(textOf(arg.OnFailText).split("{file}").join(rest.trim())); return; }
      if (resp && !ok) conPrint(`[${conds.length} condition(s) failed]`, "sys");
    } else if (/Login/.test(an)) {
      const [n, p] = rest.trim().split(/\s+/);
      const u = data.Users.find(x => eqName(x.Name, n) && eqName(x.Password || "", p || ""));
      ok = !!u;
      if (u) con.user = u.Name;
      seqs = argumentSequences(arg, ok);
    } else if (/Hack/.test(an)) {
      ok = true;
      conPrint(`[auto hack starts${data.RequiredHackDevice ? " — needs " + leaf(data.RequiredHackDevice) : ""}]`, "sys");
      seqs = argumentSequences(arg, ok);
    } else {
      ok = true;
      conPrint(`[${classLabel(arg.$class)} — simulated as success]`, "sys");
      seqs = argumentSequences(arg, ok);
    }
  }
  const out = seqs.length ? seqs : (ok ? cmd.OnSuccessSequences : cmd.OnFailSequences) || [];
  if (!ok && !out.length) printSequences(data.ErrorSequence ? [data.ErrorSequence] : []);
  else printSequences(out, vars);
}
function bootConsole() {
  const data = D();
  con = newConsole();
  if (textOf(data.SystemArt)) conPrint(textOf(data.SystemArt));
  if (textOf(data.VersionInfo)) conPrint(textOf(data.VersionInfo));
  if (data.bBootSequence) printSequences(data.BootSequences);
  if (textOf(data.GuidePrompt)) conPrint(textOf(data.GuidePrompt), "sys");
}
function renderConsole() {
  if (!con) bootConsole();
  const data = D();
  const out = el("div", { id: "conOut" }, con.lines.map(l => el("div", { class: l.cls || "" }, l.text)));
  const pr = el("span", { class: "pr" }, conPrompt());
  const inp = el("input", { type: "text", spellcheck: "false", autocomplete: "off" });
  inp.onkeydown = e => {
    if (e.key === "Enter") {
      const v = inp.value;
      if (!v.trim()) return;
      con.history.push(v); con.hi = con.history.length;
      runConsole(v);
      renderMain(); $("mainWrap").querySelector("#conLine input").focus();
    } else if (e.key === "ArrowUp" && con.history.length) {
      con.hi = Math.max(0, con.hi - 1); inp.value = con.history[con.hi]; e.preventDefault();
    } else if (e.key === "ArrowDown" && con.history.length) {
      con.hi = Math.min(con.history.length, con.hi + 1); inp.value = con.history[con.hi] || ""; e.preventDefault();
    }
  };
  const reqCb = el("input", { type: "checkbox", checked: con.reqPass });
  reqCb.onchange = () => con.reqPass = reqCb.checked;
  const condCb = el("input", { type: "checkbox", checked: con.condPass });
  condCb.onchange = () => con.condPass = condCb.checked;
  const userSel = el("select", {}, el("option", { value: "" }, "— nobody —"), data.Users.map(u => el("option", { value: u.Name }, u.Name)));
  userSel.value = con.user;
  userSel.onchange = () => { con.user = userSel.value; renderMain(); };
  const side = el("div", { id: "conSide" },
    el("div", { class: "sec" }, "Preview"),
    el("div", { class: "note" }, "Runs this terminal's data the way the game does. Sequences show their text; Blueprint widgets, events and hacking are only named."),
    el("label", { class: "chk" }, reqCb, "Folder requirements pass"),
    el("label", { class: "chk" }, condCb, "File conditions pass"),
    el("label", {}, "Logged in as"), userSel,
    el("div", { class: "sec" }, "Commands"),
    el("div", { class: "chips" }, data.Commands.map(c => el("a", { href: "#", class: "chip", onclick: e => { e.preventDefault(); inp.value = c.Keyword + " "; inp.focus(); } }, c.Keyword))),
    el("div", { style: "margin-top:14px" }, btn("Restart", () => { bootConsole(); renderMain(); }, "small")));
  $("mainWrap").append(el("div", { id: "console" }, el("div", { class: "conwrap" }, out, el("div", { id: "conLine" }, pr, inp)), side));
  $("mainWrap").style.overflow = "hidden";
  requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; inp.focus(); });
}

// ---------------------------------------------------------------- terminals: new / rename / delete
function openModal(title, body, buttons) {
  $("overlayTitle").textContent = title;
  $("overlayBody").innerHTML = "";
  $("overlayBody").append(body);
  $("overlayFoot").innerHTML = "";
  $("overlayFoot").append(...buttons);
  $("overlay").classList.add("open");
}
const closeModal = () => $("overlay").classList.remove("open");
const validAssetName = n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
function newTerminalDialog() {
  if (!schema) return;
  const name = el("input", { type: "text", value: "DA_Terminal_New" });
  const from = el("select", {}, el("option", { value: "" }, "Blank terminal"), terms.map((t, i) => el("option", { value: i }, "Copy of " + t.doc.name)));
  if (cur) from.value = terms.indexOf(cur);
  const body = el("div", {}, el("label", {}, "Asset name"), name, el("div", { class: "note" }, `Created as ${schema.newTerminalFolder || "?"}/<name> on the next Unreal sync.`),
    el("label", {}, "Start from"), from, el("div", { class: "note" }, "A copy gets fresh localization keys, so its texts translate separately."));
  openModal("New terminal", body, [btn("Cancel", closeModal, "ghost"), el("span", { class: "spacer" }), btn("Create", () => {
    const n = name.value.trim();
    if (!validAssetName(n)) return status("Use letters, digits and underscores only.", true);
    if (terms.some(t => eqName(t.doc.name, n))) return status(`A terminal "${n}" already exists.`, true);
    let data;
    if (from.value !== "") data = stripTextKeys(clone(terms[+from.value].doc.data));
    else {
      data = clone(classInfo(schema.root).defaults || {});
      ensureLists(data);
      data.Directories.push(Object.assign(clone(rootStruct("Directories")?.defaults || {}), { DirectoryName: "C", MotherDirectoryName: "", Requirements: [], Files: [] }));
    }
    ensureLists(data);
    const doc = { schemaSoftVersion: schema.schemaSoftVersion || 1, schemaHardVersion: schema.schemaHardVersion || 1, asset: "", name: n, sourceHash: "", data };
    const t = { file: `${TERMINALS_DIR}/${n}.json`, doc, baseline: "", baseName: n, sha: null, isNew: true };
    terms.push(t);
    terms.sort((a, b) => a.doc.name.localeCompare(b.doc.name));
    closeModal();
    tab = "settings";
    selectTerminal(t);
  }, "primary")]);
  name.focus(); name.select();
}
function renameTerminal(n) {
  n = n.trim();
  if (!cur.isNew || n === cur.doc.name) return;
  if (!validAssetName(n)) { renderMain(true); return status("Use letters, digits and underscores only.", true); }
  if (terms.some(t => t !== cur && eqName(t.doc.name, n))) { renderMain(true); return status(`A terminal "${n}" already exists.`, true); }
  if (cur.sha) deletedTerms.push({ file: cur.file, sha: cur.sha });
  cur.doc.name = n;
  cur.file = `${TERMINALS_DIR}/${n}.json`;
  cur.sha = null;
  renderToolbar(); changed("main");
}
function deleteTerminal() {
  if (!cur.isNew || !confirm(`Delete "${cur.doc.name}"? It was never synced to Unreal.`)) return;
  if (cur.sha) deletedTerms.push({ file: cur.file, sha: cur.sha });
  terms = terms.filter(t => t !== cur);
  selectTerminal(terms[0] || null);
}

// ---------------------------------------------------------------- changes + commit
const IDENTITY = { Directories: ["Folder", "DirectoryName"], Files: ["File", "Name"], Commands: ["Command", "Keyword"], Users: ["User", "Name"] };
function short(v) {
  if (v === undefined) return "—";
  if (v === null) return "None";
  if (isText(v)) return JSON.stringify(v.$text);
  if (typeof v === "object" && v.$class) return classLabel(v.$class);
  if (Array.isArray(v)) return `${v.length} entr${v.length === 1 ? "y" : "ies"}`;
  if (typeof v === "object") return "{…}";
  if (typeof v === "string" && v.includes(".") && tagSet.has(v)) return leaf(v);
  const s = typeof v === "string" ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 77) + "…\"" : s;
}
function diffValues(a, b, path, out, key) {
  if (out.length > 80 || JSON.stringify(a) === JSON.stringify(b)) return;
  if (isText(a) || isText(b)) { if (textOf(a) !== textOf(b)) out.push({ path, old: short(a), new: short(b) }); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    const id = IDENTITY[key];
    if (id) {
      const label = x => x ? String(x[id[1]] || "?") : "∅";
      const am = new Map(a.map(x => [label(x).toLowerCase(), x]));
      const bm = new Map(b.map(x => [label(x).toLowerCase(), x]));
      // An unmatched entry at the same index on both sides is a rename.
      const renamed = new Map();
      a.forEach((x, i) => {
        const y = b[i];
        if (y && !bm.has(label(x).toLowerCase()) && !am.has(label(y).toLowerCase())) renamed.set(x, y);
      });
      const renamedTo = new Set(renamed.values());
      for (const [k, x] of am) {
        if (renamed.has(x)) {
          const y = renamed.get(x);
          out.push({ path: join(path, `${id[0]} ${label(x)}`), old: label(x), new: label(y) });
          diffValues(Object.assign({}, x, { [id[1]]: y[id[1]] }), y, join(path, `${id[0]} ${label(y)}`), out);
        } else if (!bm.has(k)) out.push({ path: join(path, `${id[0]} ${label(x)}`), old: "exists", new: "deleted" });
      }
      for (const [k, x] of bm) {
        if (renamedTo.has(x)) continue;
        if (!am.has(k)) out.push({ path: join(path, `${id[0]} ${label(x)}`), old: "—", new: "added" });
        else diffValues(am.get(k), x, join(path, `${id[0]} ${label(x)}`), out);
      }
      const ao = a.map(label).filter(k => bm.has(k.toLowerCase())).join("|"), bo = b.map(label).filter(k => am.has(k.toLowerCase())).join("|");
      if (ao.toLowerCase() !== bo.toLowerCase()) out.push({ path: join(path, key), old: "order", new: "reordered" });
      return;
    }
    if (a.length !== b.length) out.push({ path: path || key, old: short(a), new: short(b) });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffValues(a[i], b[i], `${path}[${i + 1}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a.$class !== b.$class) { out.push({ path, old: short(a), new: short(b) }); return; }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === "$class") continue;
      diffValues(a[k], b[k], IDENTITY[k] ? path : join(path, k.startsWith(CMD_TAG_ROOT) ? leaf(k) : k), out, k);
    }
    return;
  }
  out.push({ path, old: short(a), new: short(b) });
}
const join = (a, b) => a ? a + " › " + b : b;
function termChanges(t) {
  const out = [];
  if (!t.baseline) return [{ path: "", old: "—", new: "new terminal" }];
  if (t.doc.name !== t.baseName) out.push({ path: "Asset name", old: t.baseName, new: t.doc.name });
  diffValues(JSON.parse(t.baseline), t.doc.data, "", out);
  return out;
}
const lineText = l => `${l.path || "Terminal"}: ${l.old} → ${l.new}`;
function showChanges() {
  const dirty = terms.filter(isDirty);
  const body = el("div", {});
  if (!dirty.length && !deletedTerms.length) body.append(el("div", { class: "empty" }, "No unsaved changes."));
  for (const t of dirty) {
    const errs = validate(t.doc.data).filter(p => p.lvl === "error").length;
    body.append(el("div", { class: "diff-item" },
      el("div", { class: "dname" }, t.doc.name, t.isNew ? el("span", { class: "badge new" }, "NEW") : null, errs ? el("span", { class: "badge err", title: "validation errors" }, errs) : null,
        el("span", { class: "spacer" }), t.baseline ? btn("Revert", () => { t.doc.data = JSON.parse(t.baseline); t.doc.name = t.baseName; ensureLists(t.doc.data); con = null; sel = null; renderAll(); showChanges(); }, "small ghost") : null),
      termChanges(t).map(l => el("div", { class: "dline" }, el("span", { class: "dpath" }, (l.path || "Terminal") + ": "), el("span", { class: "old" }, l.old), " → ", el("span", { class: "new" }, l.new)))));
  }
  for (const d of deletedTerms) body.append(el("div", { class: "diff-item" }, el("div", { class: "dname" }, d.file), el("div", { class: "dline" }, el("span", { class: "old" }, "removed from GitHub"))));
  openModal("Unsaved changes", body, [
    btn("Revert all", () => {
      if (!confirm("Discard every unsaved change?")) return;
      deletedTerms = [];
      closeModal(); load();
    }, "ghost danger"),
    el("span", { class: "spacer" }),
    btn("Commit", commit, "primary")]);
}

async function ghFetchUser(headers) {
  if (ghUser) return ghUser;
  try {
    const res = await fetch("https://api.github.com/user", { headers });
    if (res.ok) ghUser = (await res.json()).login;
  } catch (e) { /* offline lookups just fall back */ }
  return ghUser || "unknown";
}
async function remoteSha(path, headers) {
  const res = await fetch(apiUrl(path) + "?ref=" + BRANCH + "&t=" + Date.now(), { headers, cache: "no-store" });
  if (res.ok) return (await res.json()).sha;
  if (res.status === 401) throw new Error("GitHub rejected the token (401) — expired or pasted incompletely.");
  if (res.status === 404) return null;
  throw new Error(path + ": fetching current file failed: " + res.status);
}
// expectedSha: undefined = overwrite whatever is there, null = must not exist yet.
async function putFile(path, contentObj, headers, message, expectedSha) {
  const sha = await remoteSha(path, headers);
  if (expectedSha !== undefined && sha !== expectedSha) throw new Error(path + " changed on GitHub since this page loaded it (an Unreal sync?). Reload and redo the edit.");
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(contentObj, null, "\t") + "\n"))),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  const put = await fetch(apiUrl(path), { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(path + ": commit failed: " + put.status + " " + (await put.text()).slice(0, 200));
  return (await put.json()).content.sha;
}
async function deleteFile(path, sha, headers, message) {
  const remote = await remoteSha(path, headers);
  if (!remote) return;
  if (remote !== sha) throw new Error(path + " changed on GitHub since this page loaded it. Reload first.");
  const res = await fetch(apiUrl(path), { method: "DELETE", headers, body: JSON.stringify({ message, sha: remote, branch: BRANCH }) });
  if (!res.ok) throw new Error(path + ": delete failed: " + res.status);
}
async function commit() {
  const dirty = terms.filter(isDirty);
  if (!dirty.length && !deletedTerms.length) return status("Nothing to save.", true);
  const token = $("token").value.trim();
  if (!token) return status("Paste a GitHub token first (top right).", true);
  const bad = dirty.filter(t => validate(t.doc.data).some(p => p.lvl === "error"));
  if (bad.length && !confirm(`${bad.map(t => t.doc.name).join(", ")} still has validation errors. Commit anyway?`)) return;
  const headers = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" };
  const author = await ghFetchUser(headers);
  const now = new Date().toISOString();
  const entries = [];
  let done = 0;
  try {
    for (const d of deletedTerms.slice()) {
      await deleteFile(d.file, d.sha, headers, `Terminal editor: remove ${d.file}`);
      entries.push({ terminal: d.file, time: now, author, lines: ["Removed"] });
      deletedTerms.splice(deletedTerms.indexOf(d), 1);
    }
    for (const t of dirty) {
      const lines = termChanges(t).map(lineText);
      t.sha = await putFile(t.file, t.doc, headers, `Terminal editor: ${t.doc.name} (${lines.length} change${lines.length === 1 ? "" : "s"})`, t.sha || null);
      t.baseline = JSON.stringify(t.doc.data);
      t.baseName = t.doc.name;
      entries.push({ terminal: t.file, time: now, author, lines: lines.slice(0, 60) });
      done++;
    }
  } catch (e) {
    status(e.message, true);
  }
  if (entries.length) {
    try {
      const fresh = (await fetchJson(WORKFLOW_FILE)) || { log: [] };
      fresh.log = (fresh.log || []).concat(entries).slice(-LOG_CAP);
      await putFile(WORKFLOW_FILE, fresh, headers, "Terminal editor: history");
      workflow = fresh;
    } catch (e) { status("Saved, but the history log failed: " + e.message, true); }
  }
  closeModal();
  renderAll();
  if (done === dirty.length && !deletedTerms.length) status(`Committed ${done} terminal${done === 1 ? "" : "s"}. Run IRR → Terminals → Sync in Unreal to pull it in.`);
}

function validateAll() {
  const body = el("div", {});
  let total = 0;
  for (const t of terms) {
    const probs = validate(t.doc.data);
    total += probs.length;
    if (!probs.length) continue;
    body.append(el("div", { class: "diff-item" }, el("div", { class: "dname" }, t.doc.name),
      probs.map(p => el("div", { class: "dline", style: "cursor:pointer", onclick: () => { closeModal(); if (cur !== t) selectTerminal(t); if (p.target) goTo(p.target); } },
        el("span", { class: p.lvl === "error" ? "old" : "new" }, p.lvl === "error" ? "Error: " : "Warning: "), p.msg))));
  }
  if (!total) body.append(el("div", { class: "empty" }, "Every terminal passes."));
  openModal("Validation", body, [el("span", { class: "spacer" }), btn("Close", closeModal, "ghost")]);
}

// ---------------------------------------------------------------- boot
$("token").value = localStorage.getItem(TOKEN_KEY) || "";
$("saveToken").onclick = () => {
  const v = $("token").value.trim();
  v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY);
  status(v ? "Token saved in this browser." : "Token removed.");
};
$("changesBtn").onclick = showChanges;
$("validateBtn").onclick = validateAll;
$("newTerminalBtn").onclick = newTerminalDialog;
$("overlayClose").onclick = closeModal;
$("overlay").onclick = e => { if (e.target === $("overlay")) closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
window.addEventListener("beforeunload", e => { if (terms.some(isDirty) || deletedTerms.length) { e.preventDefault(); e.returnValue = ""; } });
setupPanelResize();
load();

function setupPanelResize() {
  const KEY = "irr_terminal_panel_width", DEFAULT = 460, MIN = 340;
  const panel = $("panel"), grip = $("panelResize");
  const clamp = w => Math.round(Math.max(MIN, Math.min(w, window.innerWidth - 520)));
  const apply = w => { panel.style.width = clamp(w) + "px"; };
  apply(+localStorage.getItem(KEY) || DEFAULT);
  grip.onmousedown = e => {
    e.preventDefault();
    const right = panel.getBoundingClientRect().right;
    document.body.classList.add("resizing");
    const move = ev => apply(right - ev.clientX);
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem(KEY, parseInt(panel.style.width, 10));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  grip.ondblclick = () => { localStorage.removeItem(KEY); apply(DEFAULT); };
  window.addEventListener("resize", () => apply(parseInt(panel.style.width, 10) || DEFAULT));
}
