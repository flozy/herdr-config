// Resume chats: Claude Code sessions kept to pick up again with `claude --resume <id>`.
// A running Claude writes ~/.claude/sessions/<pid>.json with its current sessionId;
// the terminal's foreground pid (hc get) leads there.
import { exec, hc } from "herdr";

export const RKEY = "resume.chats"; // [{ id, name, title, folder, machine, terminal, argv, at, renamed? }]
export const RREQ = "resume.request"; // { at, terminal, space } to mark, { at, forget } to drop

// Every session file on that machine, one JSON per line.
const LIST = 'for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] && { tr -d "\\n" < "$f"; echo; }; done';

// What runs in that terminal: { id, cwd, argv, title, machine }, or null if no Claude is found.
export async function sessionOf(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  const g = JSON.parse(r.stdout);
  const fg = g.foreground;
  if (!fg?.pid || g.state !== "live") return null;
  const machine = address.includes("/") ? address.split("/")[0] : null;
  const out = await exec("sh", ["-c", LIST], { on: machine });
  const all = out.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((s) => s?.sessionId);
  // By pid first; else the only session in that folder.
  let s = all.find((x) => x.pid === fg.pid);
  if (!s && /claude/i.test(`${fg.name ?? ""} ${(fg.argv ?? []).join(" ")}`)) {
    const here = all.filter((x) => x.cwd === fg.cwd);
    if (here.length === 1) s = here[0];
  }
  if (!s) return null;
  return { id: s.sessionId, cwd: s.cwd || fg.cwd, argv: fg.argv ?? ["claude"], title: g.title || null, machine };
}

// Options whose value is the next word.
const VALUE = new Set(["--model", "--mcp-config", "--permission-mode", "--add-dir", "--settings", "--agent", "--agents",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--append-system-prompt", "--system-prompt",
  "--plugin-dir", "--fallback-model", "--setting-sources", "--output-format", "--input-format", "--debug"]);

// The command it was started with, without what picked its session, so
// `--resume <id>` can be added: `claude --mcp-config=x -r abc "task"` -> `claude --mcp-config=x`.
export function resumeArgv(argv) {
  const [cmd, ...rest] = argv?.length ? argv : ["claude"];
  const out = [/claude/i.test(cmd) && cmd.startsWith(".") ? "claude" : cmd];
  const drop = new Set(["-r", "--resume", "--session-id", "-c", "--continue", "--fork-session", "-p", "--print"]);
  const takesValue = new Set(["-r", "--resume", "--session-id"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const flag = a.split("=")[0];
    if (drop.has(flag)) {
      if (!a.includes("=") && takesValue.has(flag) && rest[i + 1] && !rest[i + 1].startsWith("-")) i++;
      continue;
    }
    if (!a.startsWith("-")) continue; // a first prompt: not again
    out.push(a);
    if (!a.includes("=") && VALUE.has(a) && rest[i + 1] !== undefined) out.push(rest[++i]);
  }
  return out;
}

// One word for sh: as is when safe, else in single quotes.
export const q = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

// What a saved chat is resumed with in a shell: `claude --mcp-config=x --resume <id>`.
export function resumeCommand(c) {
  return [...(c.argv ?? ["claude"]), "--resume", c.id].map(q).join(" ");
}
