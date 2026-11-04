import { test, expect } from "bun:test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

// Generated systemd INI is an owned public artifact, not implementation source.
function unit(path: string) {
  const result: Record<string, Record<string, string[]>> = {};
  let section = "";
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = line.slice(1, -1); result[section] ??= {}; continue; }
    const separator = line.indexOf("=");
    if (separator < 0) throw new Error("invalid unit directive");
    (result[section][line.slice(0, separator)] ??= []).push(line.slice(separator + 1));
  }
  return result;
}

test("generated watcher connects host disable, removal and reset to the executable reconciler", async () => {
  const s = sandbox();
  try {
    expect((await s.cli(["setup", "--quiet"])).code).toBe(0);
    const dir = join(s.config, "systemd/user");
    const path = unit(join(dir, "omastoic-prune.path"));
    expect(path.Path.PathChanged.sort()).toEqual([join(s.config, "omarchy/plugins"), join(s.config, "omarchy/shell.json"), join(s.config, "omarchy/branding/screensaver.txt")].sort());
    expect(path.Path.Unit).toEqual(["omastoic-prune.service"]);
    expect(unit(join(dir, "omastoic-prune.service")).Service.ExecStart).toEqual([join(s.home, ".local/lib/omastoic/prune.sh")]);
    expect(unit(join(dir, "omastoic.service")).Service.ExecStart).toEqual([`${join(s.home, ".local/bin/omastoic")} daemon`]);
    // Real systemd parser in offline verification mode: no user bus or manager
    // is contacted. Supply minimal targets so unrelated system services/sockets
    // in the test machine's search path do not enter the verification graph.
    if (Bun.which("systemd-analyze")) {
      mkdirSync(s.env.XDG_RUNTIME_DIR, { recursive: true });
      for (const name of ["basic", "default", "graphical-session", "shutdown"]) s.put(join(dir, `${name}.target`), `[Unit]\nDescription=Test target ${name}\n`);
      const verified = await s.exec(["systemd-analyze", "--user", "verify", ...["omastoic.service", "omastoic-prune.service", "omastoic-prune.path"].map((f) => join(dir, f))], { SYSTEMD_UNIT_PATH: dir });
      expect(verified.code).toBe(0);
    }
  } finally { s.cleanup(); }
});
