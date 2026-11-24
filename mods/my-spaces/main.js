// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind; at the end
// of each row its agents' state (working, waiting for you, done, idle, or none). Click to
// switch, right-click for its menu, drag to reorder. Machines' headers drag to reorder too.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, agents, terminals, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, notify } from "herdr";
import { RKEY, RREQ, sessionOf, resumeArgv, q, resumeCommand } from "./resume.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A drag that started on "This computer"'s header (its machine is null).
const LOCAL = "\u0000local";
const STATUS_TIP = { working: "Agent arbeitet", blocked: "Wartet auf dich", done: "Fertig – noch nicht angesehen", idle: "Agent bereit (idle)", none: "Kein Agent läuft" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // Resume chats: marked from a right-click (my-menu writes RREQ), kept in
    // shared RKEY, their session id followed while they run (/clear, /resume).
    this.lastReq = shared(RREQ)?.at ?? 0;
    this.editing = null;
    this.nameInput = InputState.new({ placeholder: "Name" });
    this.nameInput.on("submit", (_e, cx) => this.finishRename(cx));
    cx.timer.every(300, (cx) => this.checkRequest(cx));
    cx.timer.every(6000, (cx) => this.followResume(cx));
  }

  chats() { return shared(RKEY) ?? []; }
  saveChats(list) { setShared(RKEY, list); }
  patchChat(id, patch) { this.saveChats(this.chats().map((c) => (c.id === id ? { ...c, ...patch } : c))); }

  checkRequest(cx) {
    const req = shared(RREQ);
    if (!req || req.at === this.lastReq) return;
    this.lastReq = req.at;
    if (req.forget) { this.saveChats(this.chats().filter((c) => c.terminal !== req.forget && c.id !== req.forget)); return; }
    // From a saved chat's right-click menu (my-menu, tab "resume").
    const chat = this.chats().find((c) => c.id === (req.open ?? req.rename));
    if (chat && req.open) { this.openChat(chat, cx); return; }
    if (chat && req.rename) { this.startRename(chat, cx); return; }
    if (!req.terminal) return;
    cx.spawn(async (cx) => {
      let s = null;
      try { s = await sessionOf(req.terminal); } catch {}
      if (!s) {
        notify({ title: "Kein Claude-Chat gefunden", body: "In diesem Terminal läuft gerade kein Claude, dessen Session ich lesen kann.", level: "warning" });
        return;
      }
      const ag = agents().find((a) => a.address === req.terminal);
      const sp = spaces().find((x) => x.id === (ag?.space ?? req.space));
      const name = sp?.name || s.cwd.replace(/\/+$/, "").split("/").pop() || "Chat";
      const title = s.title || ag?.title || name;
      const list = this.chats().filter((c) => c.id !== s.id && c.terminal !== req.terminal);
      list.unshift({ id: s.id, name, title, folder: s.cwd, machine: s.machine, terminal: req.terminal, argv: resumeArgv(s.argv), at: Date.now() });
      this.saveChats(list);
      notify({ title: "Als Resume-Chat gemerkt", body: `${title}\n${s.id}`, level: "info", timeout: 4000 });
      cx.notify();
    });
  }

  // While a marked chat runs, keep its id current; a resumed one is linked back
  // to its new terminal by its session id.
  followResume(cx) {
    const list = this.chats();
    if (!list.length || this.following) return;
    this.following = true;
    cx.spawn(async (cx) => {
      try {
        const claudes = agents().filter((a) => a.app === "claude-code" || a.program?.name === "Claude");
        const seen = {};
        for (const a of claudes) {
          try { const s = await sessionOf(a.address); if (s) seen[a.address] = { ...s, agentTitle: a.title }; } catch {}
        }
        let changed = false;
        const next = this.chats().map((c) => {
          const byTerm = c.terminal && seen[c.terminal];
          const byId = Object.entries(seen).find(([, s]) => s.id === c.id);
          const [addr, s] = byTerm ? [c.terminal, byTerm] : byId ?? [null, null];
          if (!s) return c;
          const upd = { ...c, terminal: addr, id: s.id, folder: s.cwd || c.folder };
          if (s.title) upd.title = s.title;
          // The name follows its space's name until renamed here.
          const spName = spaces().find((x) => x.id === claudes.find((a) => a.address === addr)?.space)?.name;
          if (!c.renamed && spName && spName !== "~") upd.name = spName;
          if (JSON.stringify(upd) !== JSON.stringify(c)) changed = true;
          return upd;
        });
        if (changed) { this.saveChats(next); cx.notify(); }
      } finally { this.following = false; }
    });
  }

  liveAgent(c) {
    return c.terminal ? agents().find((a) => a.address === c.terminal && (a.app === "claude-code" || a.program?.name === "Claude")) : null;
  }

  // Opens a saved chat, every time: where Claude still runs it, go there; where its
  // terminal is left with a shell (Claude ended), resume it right there; otherwise
  // a new space resumes it. A listed agent alone isn't proof: its last report can
  // outlive Claude, so the terminal's foreground is asked.
  openChat(c, cx) {
    if (this.opening === c.id) return;
    if (c.starting && Date.now() - c.starting < 8000 && !c.terminal) return; // a resume is on its way
    this.opening = c.id;
    cx.spawn(async (cx) => {
      try {
        const live = this.liveAgent(c);
        let running = null;
        if (live) { try { running = await sessionOf(live.address); } catch {} }
        if (live && running) {
          if (running.id !== c.id) this.patchChat(c.id, { id: running.id });
          if (live.pane) { run("space.select", { id: live.space }); run("pane.focus", { terminal: live.address }); }
          else run("terminal.peek", { terminal: live.address });
          return;
        }
        const pane = c.terminal && panes().find((p) => p.terminal === c.terminal && p.program?.shell);
        if (pane) {
          const sp = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === pane.tab));
          if (sp) run("space.select", { id: sp.id });
          run("pane.focus", { terminal: c.terminal });
          const r = await hc(["send", c.terminal, `cd ${q(c.folder)} && ${resumeCommand(c)}`]);
          if (r.code === 0) { this.patchChat(c.id, { starting: Date.now() }); return; }
        }
        this.patchChat(c.id, { starting: Date.now(), terminal: null });
        run("space.new", { machine: c.machine ?? "", folder: c.folder, name: c.name, argv: [...(c.argv ?? ["claude"]), "--resume", c.id] });
      } finally {
        this.opening = null;
        cx.notify();
      }
    });
  }

  chatMenu(c) {
    openOverlay({ mod: "my-menu", kind: "popup", width: 270, height: 260, props: { tab: "resume", target: { id: c.id } } });
  }

  startRename(c, cx) {
    this.editing = c.id;
    this.nameInput.set_value(c.name);
    this.nameInput.focus();
    cx.notify();
  }

  finishRename(cx) {
    const v = this.nameInput.value().trim();
    if (this.editing && v) this.patchChat(this.editing, { name: v, renamed: true });
    this.editing = null;
    cx.notify();
  }

  resumeSection(t, collapsed) {
    const list = this.chats();
    if (!list.length) return [];
    const head = h_flex().id("resume-head").h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
      .child(svg("mods/workspace-chrome/pin.svg").size(13).flex_none())
      .when(!collapsed, (el) => el.child(div().flex_1().truncate().child("Fortsetzen")).child(div().child(String(list.length))));
    const icon = (id, name, tip, fn, hoverColor) => div().id(id).flex_none().p(3).rounded(5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(hoverColor ?? t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(`mods/workspace-chrome/${name}.svg`).size(12));
    const rows = list.map((c, i) => {
      const live = this.liveAgent(c);
      const dot = live ? (t[live.status] ?? t.idle) : t.dim;
      if (collapsed) {
        return h_flex().id(`rc-${i}`).h(26).flex_none().justify_center().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openChat(c, cx)).on_mouse_down("right", () => this.chatMenu(c))
          .child(div().text_color(dot).child(live ? "●" : "○"));
      }
      if (this.editing === c.id) {
        return h_flex().id(`rc-${i}`).h(32).flex_none().px(6).items_center()
          .child(Input.new(this.nameInput).flex_1().h(26).px(7).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))
          .child(icon(`rc-ok-${i}`, "check", "Speichern", (cx) => this.finishRename(cx)));
      }
      const sub = [c.machine, c.title !== c.name ? c.title : null, live ? "läuft" : null].filter(Boolean).join(" · ");
      return h_flex().id(`rc-${i}`).h(36).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(`${c.folder}\n${resumeCommand(c)}\nRechtsklick: Menü (Resume-Befehl kopieren …)`)
        .on_click((_e, cx) => this.openChat(c, cx))
        .on_mouse_down("right", () => this.chatMenu(c))
        .child(div().w(10).flex_none().text_size(10).text_color(dot).child(live ? "●" : "○"))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(c.name || c.title))
          .child(div().truncate().text_size(11).text_color(t.dim).child(sub)))
        .child(icon(`rc-ren-${i}`, "square-pen", "Umbenennen", (cx) => this.startRename(c, cx)))
        .child(icon(`rc-done-${i}`, "circle-check", "Fertig: aus der Liste nehmen", () => this.saveChats(this.chats().filter((x) => x.id !== c.id)), t.done));
    });
    return [head, ...rows, div().h(8).flex_none()];
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "my-menu", kind: "popup", width: 230, height: 300, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = this.sortMachines([...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])]);
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const from = remote.indexOf(this.mPressed), to = remote.indexOf(m);
      const dropping = m && this.mPressed && this.mOver === m && this.mPressed !== m;
      const head = h_flex().relative().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
        .when(m && this.mPressed === m && this.mOver !== m, el => el.opacity(0.5))
        .when(dropping, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < to, line => line.bottom(0)).when(from > to, line => line.top(0))))
        .tooltip(m ? "Klicken: ein-/ausklappen · Ziehen: Reihenfolge ändern" : "Klicken: ein-/ausklappen")
        .on_mouse_down("left", () => { this.mPressed = m ?? LOCAL; this.mOver = m ?? LOCAL; })
        .on_mouse_down("right", () => openOverlay({ mod: "my-menu", kind: "popup", width: 230, height: 140, props: { tab: "machine", target: { name: m, all: remote } } }))
        .on_mouse_move((_e, cx) => this.overMachine(m, cx))
        .on_mouse_up("left", (_e, cx) => {
          if (this.mPressed === (m ?? LOCAL)) {
            folded ? this.folded.delete(m) : this.folded.add(m);
            localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
            this.mPressed = this.mOver = null;
            cx.notify();
          } else this.dropMachine(m, cx);
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "space-launcher", kind: "popup", width: 340, height: 420, props: { machine: m } }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openOverlay({ mod: "space-launcher", kind: "popup", width: 340, height: 420, props: { machine: m } }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.mPressed) return this.overMachine(w.machine ?? null, cx);
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.mPressed) return this.dropMachine(w.machine ?? null, cx);
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .child(this.statusMark(w, t)),
      );
  }

  // What runs in a space, after its name: a spinner while an agent works, a dot
  // when one waits for you or finished, a ring when they're idle, a dash when none runs.
  statusMark(w, t) {
    const st = w.status ?? null;
    const tip = STATUS_TIP[st ?? "none"];
    const box = div().id(`space-status-${w.id}`).w(14).flex_none().flex().items_center().justify_center().tooltip(tip);
    if (st === "working") return box.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900));
    if (st === "blocked" || st === "done") return box.text_size(11).text_color(t[st]).child("●");
    if (st === "idle") return box.text_size(11).text_color(t.idle).child("○");
    return box.text_size(11).text_color(t.dim).opacity(0.6).child("–");
  }

  // Machines in the order dragged to (machines.order), new ones after, by name.
  sortMachines(names) {
    const order = this.machineOrder();
    const at = (n) => { const i = order.indexOf(n); return i === -1 ? Infinity : i; };
    return names.sort((a, b) => at(a) - at(b) || a.localeCompare(b));
  }

  // Shared (my-menu's "Nach oben/unten" writes it too) and kept in shared.json.
  machineOrder() {
    const order = shared("machines.order");
    if (Array.isArray(order)) return order;
    try { return JSON.parse(localStorage.getItem("machines.order") ?? "[]"); } catch { return []; }
  }

  overMachine(m, cx) {
    const over = m && this.mPressed && this.mPressed !== LOCAL ? m : null;
    if (this.mPressed && this.mOver !== over) { this.mOver = over; cx.notify(); }
  }

  // Drops the dragged machine where `m` is; "This computer" stays first.
  dropMachine(m, cx) {
    const from = this.mPressed;
    this.mPressed = this.mOver = null;
    if (from && from !== LOCAL && m && m !== from) {
      const names = this.sortMachines([...new Set([...spaces().map(s => s.machine).filter(Boolean), ...this.machines.map(k => k.name), ...Object.keys(this.reconnecting)])]);
      const fi = names.indexOf(from), ti = names.indexOf(m);
      if (fi !== -1 && ti !== -1) {
        names.splice(fi, 1);
        names.splice(ti, 0, from);
        setShared("machines.order", names);
      }
    }
    cx.notify();
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => {
          this.pressed = null;
          if (this.mPressed) return this.dropMachine(this.mOver === LOCAL ? null : this.mOver, cx);
          cx.notify();
        })
        .children([...this.resumeSection(t, collapsed), ...this.grouped(t, collapsed)]));
  }
}
