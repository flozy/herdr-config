// Popup for a machine's "+" in the spaces list: saved folders + commands
// (e.g. /home/flo/nixos-config + claude), an empty space, or a new entry
// that is saved for next time. Entries live in shared "space-launcher.presets",
// keyed by machine ("local" for this computer).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, shared, setShared } from "herdr";

const KEY = "space-launcher.presets";
const SEED = [
  { folder: "/home/flo/nixos-config", cmd: "claude" },
  { folder: "/home/flo/.config/herdr-app", cmd: "claude" },
];

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
    this.folder = InputState.new({ placeholder: "/home/flo/projekt" });
    this.cmd = InputState.new({ placeholder: "claude", value: "claude" });
    this.folder.on("submit", () => this.addAndStart());
    this.cmd.on("submit", () => this.addAndStart());
    this.handle.focus();
  }

  machine() { return props()?.machine ?? null; }
  mkey() { return this.machine() ?? "local"; }
  presets() {
    const all = shared(KEY) ?? {};
    return all[this.mkey()] ?? SEED;
  }
  save(list) { setShared(KEY, { ...(shared(KEY) ?? {}), [this.mkey()]: list }); }

  start(p) {
    closeOverlay(props().overlay);
    const args = { machine: this.machine() ?? "" };
    if (p?.folder) {
      args.folder = p.folder;
      const last = p.folder.replace(/\/+$/, "").split("/").pop();
      if (last) args.name = last;
    }
    const argv = p ? argvOf(p.cmd) : undefined;
    if (argv) args.argv = argv;
    run("space.new", args);
  }

  addAndStart() {
    const folder = this.folder.value().trim();
    const cmd = this.cmd.value().trim();
    if (!folder && !cmd) return;
    const p = { folder, cmd };
    const list = this.presets().filter(x => !(x.folder === folder && x.cmd === cmd));
    this.save([...list, p]);
    this.start(p);
  }

  render() {
    const t = theme();
    const list = this.presets();
    const row = (id, title, sub, onClick, onDelete) => h_flex().id(id).h(40).px(9).gap(10).rounded(7).items_center().flex_none()
      .hover(s => s.bg(t.selected)).cursor_pointer().on_click(onClick)
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(title))
        .when(Boolean(sub), el => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .when(Boolean(onDelete), el => el.child(div().id(`${id}-del`).flex_none().px(6).py(2).rounded(5).text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.blocked)).tooltip("Eintrag entfernen")
        .on_click((_e, cx) => { cx.stop_propagation(); onDelete(); })
        .child(svg("mods/workspace-chrome/x.svg").size(12))));
    const field = (state) => Input.new(state).h(32).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return v_flex().id("space-launcher").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().bg(t.popover).p(6).text_size(12.8).text_color(t.foreground)
      .child(div().px(9).pt(4).pb(6).text_size(11).text_color(t.dim).child(`Neuer Space auf ${this.machine() ?? "diesem Computer"}`))
      .child(v_flex().id("sl-list").h(Math.min(240, (list.length + 1) * 40)).flex_none().overflow_y_scrollbar()
        .children(list.map((p, i) => row(`sl-${i}`, (p.folder || "~").replace(/\/+$/, "").split("/").pop() || "/", `${p.folder || "~"}  ·  ${p.cmd ? `$ ${p.cmd}` : "Shell"}`, () => this.start(p),
          () => this.save(list.filter((_, j) => j !== i)))))
        .child(row("sl-empty", "Leerer Space", "nur eine Shell", () => this.start(null))))
      .child(div().h(1).my(6).bg(t.border).flex_none())
      .child(v_flex().px(6).pb(4).gap(6).flex_none()
        .child(div().text_size(11).text_color(t.dim).child("Neuer Eintrag: Ordner und Befehl"))
        .child(field(this.folder))
        .child(field(this.cmd))
        .child(h_flex().justify_end().child(h_flex().id("sl-add").h(30).px(12).items_center().rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium().cursor_pointer()
          .hover(s => s.opacity(0.88)).on_click(() => this.addAndStart()).child("Speichern & starten"))));
  }
}
