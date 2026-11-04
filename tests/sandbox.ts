import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_ID } from "../src/plugin-id.ts";

export const root = join(import.meta.dir, "..");
export function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "omastoic-test-"));
  const config = join(home, ".config");
  const state = join(home, ".state/omastoic");
  const data = join(home, ".data");
  const bin = join(home, "bin");
  const plugin = join(config, "omarchy/plugins", PLUGIN_ID);
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const stub = (name: string, body: string) => { const path = join(bin, name); put(path, `#!/bin/bash\nset -eu\n${body}\n`); chmodSync(path, 0o755); };
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "bun"));
  put(join(plugin, "manifest.json"), JSON.stringify({ id: PLUGIN_ID }));
  put(join(config, "omarchy/shell.json"), JSON.stringify({ plugins: [{ id: PLUGIN_ID, enabled: true }] }));
  stub("systemctl", `echo "$*" >> "$HOME/systemctl.log"
if [[ -n \${SYSTEMCTL_FAIL:-} && "$*" == *"$SYSTEMCTL_FAIL"* ]]; then echo "mock systemctl failure" >&2; exit 1; fi
unit=\${!#}
if [[ "$*" == *disable* || "$*" == *stop* ]]; then rm -f "$HOME/$unit.active"; fi
if [[ "$*" == *disable* ]]; then rm -f "$HOME/$unit.enabled"; fi
if [[ "$*" == *enable* ]]; then touch "$HOME/$unit.enabled"; fi
if [[ "$*" == *--now* && "$*" == *enable* || "$*" == *restart* || "$*" == *start* ]]; then touch "$HOME/$unit.active"; fi
exit 0`);
  stub("omarchy-toggle-enabled", '[[ -f "$HOME/toggle" ]]');
  stub("omarchy-toggle", 'if [[ $2 == on ]]; then touch "$HOME/toggle"; else rm -f "$HOME/toggle"; fi');
  stub("omarchy", 'if [[ ${1:-} == plugin && ${2:-} == remove ]]; then rm -rf "$XDG_CONFIG_HOME/omarchy/plugins/$3"; fi');
  stub("omarchy-notification-send", "exit 0");
  stub("omarchy-launch-screensaver", "exit 0");
  stub("ttfx", "exit 0");
  stub("hyprctl", 'if [[ -f "$HOME/clients.json" && $1 == clients ]]; then cat "$HOME/clients.json"; else echo "[]"; fi');
  stub("xdg-terminal-exec", "echo foot.desktop");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(home, ".state"), XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "runtime"), HYPRLAND_INSTANCE_SIGNATURE: "test", PATH: `${bin}:${process.env.PATH}`, OMARCHY_PATH: join(home, "host") };
  const exec = async (command: string[], extra: Record<string, string> = {}) => {
    const process = Bun.spawn(command, { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { stdout, stderr, code };
  };
  return { home, config, state, data, bin, plugin, env, put, stub,
    cli: (args: string[], extra: Record<string, string> = {}) => exec([process.execPath, join(root, "src/cli.ts"), ...args], extra),
    prune: () => exec(["bash", join(root, "scripts/prune.sh")]),
    log: () => { try { return readFileSync(join(home, "systemctl.log"), "utf8"); } catch { return ""; } },
    cleanup: () => rmSync(home, { recursive: true, force: true }), exec };
}
