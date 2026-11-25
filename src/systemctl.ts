import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export type SystemctlContext = {
  env: Record<string, string | undefined>;
  systemctlPath: string | null;
  passwdHome: string | null;
};

export type SystemctlQueryResult = {
  skipped: boolean;
  exitCode: number;
  stdout: string;
};

export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isSystemBinaryPath(resolvedPath: string): boolean {
  return (
    resolvedPath.startsWith("/usr/") ||
    resolvedPath.startsWith("/bin/") ||
    resolvedPath.startsWith("/sbin/") ||
    resolvedPath.startsWith("/run/current-system/") ||
    resolvedPath.startsWith("/nix/store/")
  );
}

export function parsePasswdHomedir(passwdContent: string, uid: number): string | null {
  const target = String(uid);
  for (const line of passwdContent.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(":");
    if (fields.length >= 6 && fields[2] === target) {
      return fields[5] || null;
    }
  }
  return null;
}

export function readPasswdHomedir(uid: number | undefined = process.getuid?.()): string | null {
  if (uid == null) return null;
  try {
    const fromFile = parsePasswdHomedir(readFileSync("/etc/passwd", "utf8"), uid);
    if (fromFile) return fromFile;
  } catch {
    // Fall back to getent when /etc/passwd is unavailable.
  }
  try {
    if (Bun.which("getent")) {
      const result = Bun.spawnSync(["getent", "passwd", String(uid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode === 0) {
        return parsePasswdHomedir(result.stdout.toString(), uid);
      }
    }
  } catch {
    // Ignore lookup failures.
  }
  return null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function shouldSkipSystemctl(ctx: SystemctlContext): boolean {
  if (isTruthyEnv(ctx.env.OMASTOIC_NO_SYSTEMCTL)) return true;
  if (!ctx.systemctlPath) return true;
  const resolvedBin = canonicalPath(ctx.systemctlPath);
  // Test stubs (such as $HOME/bin/systemctl in tests/sandbox.ts) live outside
  // system binary directories and continue to execute under isolated HOME/tests.
  if (!isSystemBinaryPath(resolvedBin)) return false;
  const nodeEnv = ctx.env.NODE_ENV?.trim().toLowerCase();
  const bunEnv = ctx.env.BUN_ENV?.trim().toLowerCase();
  if (nodeEnv === "test" || bunEnv === "test") return true;
  const envHome = ctx.env.HOME?.trim();
  if (!envHome) return true;
  if (ctx.passwdHome && canonicalPath(envHome) !== canonicalPath(ctx.passwdHome)) {
    return true;
  }
  return false;
}

function currentContext(): SystemctlContext {
  return {
    env: process.env,
    systemctlPath: Bun.which("systemctl"),
    passwdHome: readPasswdHomedir(),
  };
}

export function systemctlSkipped(): boolean {
  return shouldSkipSystemctl(currentContext());
}

export async function runSystemctl(args: string[]): Promise<number> {
  if (systemctlSkipped()) return 0;
  return Bun.spawn(["systemctl", "--user", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

export async function checkedSystemctl(args: string[]): Promise<void> {
  const cmd = ["systemctl", "--user", ...args];
  const code = await runSystemctl(args);
  if (code !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (exit ${code}); check the user session bus and journalctl --user -u omastoic.service, then retry setup`,
    );
  }
}

export function querySystemctl(args: string[]): SystemctlQueryResult {
  if (systemctlSkipped()) {
    return { skipped: true, exitCode: 3, stdout: "" };
  }
  const proc = Bun.spawnSync(["systemctl", "--user", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    skipped: false,
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
  };
}

export function isUnitActive(unit: string): boolean {
  const result = querySystemctl(["is-active", "--quiet", unit]);
  return !result.skipped && result.exitCode === 0;
}

export function isUnitEnabled(unit: string): boolean {
  const result = querySystemctl(["is-enabled", "--quiet", unit]);
  return !result.skipped && result.exitCode === 0;
}
