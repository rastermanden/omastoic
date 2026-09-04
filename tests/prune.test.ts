import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BEGIN, withBlock } from "../src/menu.ts";

const prune = join(import.meta.dir, "../scripts/prune.sh");

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "omastoic-prune-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemctl"), "#!/bin/bash\nexit 0\n");
  writeFileSync(join(bin, "omarchy-toggle"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "omarchy-toggle"), 0o755);
  return { home, bin };
}

function envFor(home: string, bin: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: `${bin}:${process.env.PATH}`,
  };
}

async function runPrune(home: string, bin: string) {
  const proc = Bun.spawn(["bash", prune], {
    env: envFor(home, bin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("prune is a no-op while the plugin directory exists even without a manifest", async () => {
  const { home, bin } = tempHome();
  try {
    mkdirSync(join(home, ".config/omarchy/plugins/omastoic"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const launcher = join(home, ".local/bin/omastoic");
    writeFileSync(launcher, "#!/bin/bash\n");
    const { code } = await runPrune(home, bin);
    expect(code).toBe(0);
    expect(existsSync(launcher)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prune is a no-op while the plugin is installed", async () => {
  const { home, bin } = tempHome();
  try {
    const config = join(home, ".config");
    mkdirSync(join(config, "omarchy/plugins/omastoic"), { recursive: true });
    writeFileSync(join(config, "omarchy/plugins/omastoic/manifest.json"), "{}\n");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const launcher = join(home, ".local/bin/omastoic");
    writeFileSync(launcher, "#!/bin/bash\n");
    const { code, stderr } = await runPrune(home, bin);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(launcher)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prune removes leftover menu, launcher and completions when the plugin is gone", async () => {
  const { home, bin } = tempHome();
  try {
    const config = join(home, ".config");
    const data = join(home, ".local/share");
    const state = join(home, ".local/state");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    mkdirSync(join(data, "bash-completion/completions"), { recursive: true });
    mkdirSync(join(data, "fish/vendor_completions.d"), { recursive: true });
    mkdirSync(join(config, "omarchy/extensions"), { recursive: true });
    mkdirSync(join(config, "omarchy/branding"), { recursive: true });
    mkdirSync(join(config, "systemd/user"), { recursive: true });
    mkdirSync(join(state, "omastoic"), { recursive: true });
    mkdirSync(join(home, ".local/lib/omastoic"), { recursive: true });

    const launcher = join(home, ".local/bin/omastoic");
    writeFileSync(launcher, "#!/bin/bash\n");
    writeFileSync(join(data, "bash-completion/completions/omastoic"), "# bash\n");
    writeFileSync(join(data, "fish/vendor_completions.d/omastoic.fish"), "# fish\n");
    writeFileSync(join(config, "systemd/user/omastoic.service"), "[Unit]\n");
    writeFileSync(join(config, "systemd/user/omastoic-prune.path"), "[Path]\n");
    writeFileSync(join(config, "systemd/user/omastoic-prune.service"), "[Service]\n");
    writeFileSync(join(home, ".local/lib/omastoic/prune.sh"), "#!/bin/bash\n");

    const menu = join(config, "omarchy/extensions/omarchy-menu.jsonc");
    const original = `{
  // keep me
  "style": {"label":"Style"},
}
`;
    writeFileSync(menu, withBlock(original));
    expect(readFileSync(menu, "utf8")).toContain(BEGIN);

    const branding = join(config, "omarchy/branding/screensaver.txt");
    const backup = join(config, "omarchy/branding/screensaver.txt.pre-omastoic");
    const canvas = "stoic canvas\n";
    writeFileSync(branding, canvas);
    writeFileSync(backup, "omarchy art\n");
    writeFileSync(
      join(state, "omastoic/written.sha"),
      createHash("sha256").update(canvas).digest("hex"),
    );

    const { code, stderr } = await runPrune(home, bin);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(launcher)).toBe(false);
    expect(existsSync(join(data, "bash-completion/completions/omastoic"))).toBe(false);
    expect(existsSync(join(data, "fish/vendor_completions.d/omastoic.fish"))).toBe(false);
    expect(existsSync(join(config, "systemd/user/omastoic.service"))).toBe(false);
    expect(existsSync(join(config, "systemd/user/omastoic-prune.path"))).toBe(false);
    expect(existsSync(join(home, ".local/lib/omastoic"))).toBe(false);
    expect(readFileSync(menu, "utf8")).toBe(original);
    expect(readFileSync(branding, "utf8")).toBe("omarchy art\n");
    expect(existsSync(backup)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prune leaves branding alone when omastoic no longer owns the slot", async () => {
  const { home, bin } = tempHome();
  try {
    const config = join(home, ".config");
    const state = join(home, ".local/state");
    mkdirSync(join(config, "omarchy/branding"), { recursive: true });
    mkdirSync(join(state, "omastoic"), { recursive: true });
    const branding = join(config, "omarchy/branding/screensaver.txt");
    const backup = join(config, "omarchy/branding/screensaver.txt.pre-omastoic");
    writeFileSync(branding, "user art\n");
    writeFileSync(backup, "old art\n");
    writeFileSync(join(state, "omastoic/written.sha"), "not-the-current-hash\n");

    const { code } = await runPrune(home, bin);
    expect(code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("user art\n");
    expect(existsSync(backup)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
