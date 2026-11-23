// Popup for a machine's "+" in the spaces list: saved folders + commands
// (e.g. ~/nixos-config + claude), an empty space, or a new entry
// that is saved for next time. Entries live in shared "space-launcher.presets",
// keyed by machine ("local" for this computer). "~" is that machine's home; a
// folder that isn't there says so instead of starting nothing. Each machine shows
// only its own entries, plus suggestions from the folders its open spaces are in;
// folders that don't exist on that machine are hidden.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, shared, setShared, exec, notify, spaces, panes } from "herdr";

const KEY = "space-launcher.presets";
const SEED = [
  { folder: "~/nixos-config", cmd: "claude" },
  { folder: "~/.config/herdr-app", cmd: "claude" },
];

const norm = (f) => (f ?? "").trim().replace(/(.)\/+$/, "$1");

// Absolute path of folder on that machine ("~" = its home), or null if missing.
async function resolve(folder, on) {
  const r = await exec("sh", ["-c", 'd=$1; case $d in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; cd -- "$d" 2>/dev/null && pwd', "sh", folder.trim()], { on });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Plain words become argv; anything with shell syntax runs through sh -lc.
function argvOf(cmd) {
  const c = cmd.trim();
  if (!c) return undefined;
  if (/[|&;<>()$`"'*?~\\]/.test(c)) return ["sh", "-lc", c];
  return c.split(/\s+/);
}

export default class SpaceLauncher extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.folder = InputState.new({ placeholder: "~/projekt" });
    this.cmd = InputState.new({ placeholder: "claude", value: "claude" });
    this.folder.on("submit", (_e, cx) => this.addAndStart(cx));
    this.cmd.on("submit", (_e, cx) => this.addAndStart(cx));
    this.handle.focus();
    this.where = {}; // folder -> absolute path, false (missing), null (machine away); absent = unchecked
    this.check(cx);
  }

  // Ask the machine where the folders are; unknown ones stay visible until answered.
  check(cx) {
    const on = this.machine() ?? undefined;
    const todo = [...new Set([...this.presets(), ...this.suggestions()].map(p => p.folder).filter(f => f && !(f in this.where)))];
    if (!todo.length) return;
    for (const f of todo) this.where[f] = undefined; // asked; don't ask again while waiting
    cx.spawn(async (cx) => {
      await Promise.all(todo.map(async (f) => {
        try { this.where[f] = (await resolve(f, on)) ?? false; }
        catch { this.where[f] = null; /* machine away: keep showing */ }
      }));
      cx.notify();
    });
  }

  machine() { return props()?.machine ?? null; }
  mkey() { return this.machine() ?? "local"; }
  presets() {
    const all = shared(KEY) ?? {};
    return all[this.mkey()] ?? (this.machine() ? [] : SEED);
  }
  // Folders this machine's open spaces are in now, with the agent running there.
  suggestions() {
    const m = this.machine();
    const tabs = new Set(spaces().filter(s => (s.machine ?? null) === m).flatMap(s => s.tabs.map(t => t.id)));
    const saved = new Set(this.presets().flatMap(p => [norm(p.folder), this.where?.[p.folder]]).filter(Boolean));
    const out = new Map();
    for (const p of panes()) {
      if (!p.terminal || !p.cwd || !tabs.has(p.tab)) continue;
      const f = norm(p.cwd);
      if (saved.has(f) || f === "~") continue;
      const cmd = p.program?.agent ? p.program.key : "claude";
      if (!out.has(f) || p.program?.agent) out.set(f, { folder: f, cmd });
    }
    return [...out.values()];
  }
  shown(p) { return !p.folder || this.where[p.folder] !== false; }
  save(list) { setShared(KEY, { ...(shared(KEY) ?? {}), [this.mkey()]: list }); }

  // Starts a new space every time, even where one for that folder runs already.
  // The folder is checked (and "~" resolved) on its machine first; the popup
  // closes only after, since closing it ends its tasks.
  start(p, cx) {
    if (this.starting) return;
    this.starting = true;
    cx.spawn(async (cx) => {
      const args = { machine: this.machine() ?? "" };
      if (p?.folder) {
        const on = this.machine() ?? undefined;
        let folder;
        try { folder = await resolve(p.folder, on); } catch { folder = null; }
        if (!folder) {
          this.starting = false;
          notify({ title: "Ordner nicht gefunden", body: `${p.folder} gibt es auf ${this.machine() ?? "diesem Computer"} nicht. Eintrag mit × entfernen und neu anlegen.`, level: "warning" });
          cx.notify();
          return;
        }
        args.folder = folder;
        const last = folder.replace(/\/+$/, "").split("/").pop();
        if (last) args.name = last;
      }
      const argv = p ? argvOf(p.cmd) : undefined;
      if (argv) args.argv = argv;
      closeOverlay(props().overlay);
      run("space.new", args);
    });
  }

  addAndStart(cx) {
    const folder = this.folder.value().trim();
    const cmd = this.cmd.value().trim();
    if (!folder && !cmd) return;
    const p = { folder, cmd };
    const list = this.presets().filter(x => !(x.folder === folder && x.cmd === cmd));
    this.save([...list, p]);
    this.start(p, cx);
  }

  render(cx) {
    const t = theme();
    const list = this.presets();
    const sugg = this.suggestions().filter(p => this.shown(p));
    if ([...list, ...sugg].some(p => p.folder && !(p.folder in this.where))) this.check(cx);
    const title = (p) => norm(p.folder || "~").split("/").pop() || "/";
    const sub = (p, extra) => `${p.folder || "~"}  ·  ${p.cmd ? `$ ${p.cmd}` : "Shell"}${extra ?? ""}`;
    const row = (id, title, sub, onClick, onDelete) => h_flex().id(id).h(40).px(9).gap(10).rounded(7).items_center().flex_none()
      .hover(s => s.bg(t.selected)).cursor_pointer().on_click(onClick)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(title))
        .when(Boolean(sub), el => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .when(Boolean(onDelete), el => el.child(div().id(`${id}-del`).flex_none().px(6).py(2).rounded(5).text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.blocked)).tooltip("Eintrag entfernen")
        .on_click((_e, cx) => { cx.stop_propagation(); onDelete(); })
        .child(svg("mods/workspace-chrome/x.svg").size(12))));
    const rows = [
      ...list.map((p, i) => [p, i]).filter(([p]) => this.shown(p)).map(([p, i]) => row(`sl-${i}`, title(p), sub(p), (_e, cx) => this.start(p, cx),
        () => this.save(list.filter((_, j) => j !== i)))),
      ...sugg.map((p, i) => row(`sl-s-${i}`, title(p), sub(p, "  ·  offen"), (_e, cx) => { this.save([...list, p]); this.start(p, cx); })),
    ];
    const field = (state) => Input.new(state).h(32).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return v_flex().id("space-launcher").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().bg(t.popover).p(6).text_size(12.8).text_color(t.foreground)
      .child(div().px(9).pt(4).pb(6).text_size(11).text_color(t.dim).child(`Neuer Space auf ${this.machine() ?? "diesem Computer"}`))
      .child(v_flex().id("sl-list").h(Math.min(240, (rows.length + 1) * 40)).flex_none().overflow_y_scrollbar()
        .children(rows)
        .child(row("sl-empty", "Leerer Space", "nur eine Shell", (_e, cx) => this.start(null, cx))))
      .child(div().h(1).my(6).bg(t.border).flex_none())
      .child(v_flex().px(6).pb(4).gap(6).flex_none()
        .child(div().text_size(11).text_color(t.dim).child("Neuer Eintrag: Ordner und Befehl"))
        .child(field(this.folder))
        .child(field(this.cmd))
        .child(h_flex().justify_end().child(h_flex().id("sl-add").h(30).px(12).items_center().rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium().cursor_pointer()
          .hover(s => s.opacity(0.88)).on_click((_e, cx) => this.addAndStart(cx)).child("Speichern & starten"))));
  }
}
