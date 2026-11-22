/** OS file picker boundary for custom-author portraits via xdg-desktop-portal. */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

export const PORTRAIT_PICKER_TITLE = "Choose portrait image";
export const PORTRAIT_PICKER_UNAVAILABLE_NOTICE = "Could not open the file picker. Type a path instead.";
export const PORTRAIT_PICKER_UNSUPPORTED_NOTICE = "Choose a JPEG or PNG saved on this computer.";

export const PORTRAIT_PICKER_EXIT = {
  PICKED: 0,
  CANCELLED: 1,
  UNAVAILABLE: 2,
  UNSUPPORTED: 3,
} as const;

export type PortraitPickerResult =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string }
  | { status: "unsupported"; reason: string };

export type PortalRunnerResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type PortalRunner = (
  command: string[],
  env: Record<string, string | undefined>,
) => Promise<PortalRunnerResult>;

const DEFAULT_SCRIPT_PATH = join(dirname(import.meta.dir), "scripts/portal-pick-image.py");

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Prefer ~/Pictures when it exists as a directory; fall back to $HOME, else portal default. */
export function resolvePortraitStartFolder(home: string): string | null {
  if (!home) return null;
  const pictures = join(home, "Pictures");
  if (isDirectory(pictures)) return pictures;
  if (isDirectory(home)) return home;
  return null;
}

export function buildPortalPickerArgs(options: {
  title?: string;
  folder?: string | null;
  scriptPath?: string;
} = {}): string[] {
  const args = [
    options.scriptPath ?? DEFAULT_SCRIPT_PATH,
    "--title",
    options.title ?? PORTRAIT_PICKER_TITLE,
  ];
  if (options.folder) args.push("--folder", options.folder);
  return args;
}

export function parsePortalPickerOutput(code: number, stdout: string, stderr: string): PortraitPickerResult {
  if (code === PORTRAIT_PICKER_EXIT.PICKED) {
    const path = stdout.replace(/\r?\n$/, "");
    if (!path) return { status: "cancelled" };
    if (/[\r\n\0]/.test(path)) {
      return { status: "unsupported", reason: PORTRAIT_PICKER_UNSUPPORTED_NOTICE };
    }
    return { status: "picked", path };
  }
  if (code === PORTRAIT_PICKER_EXIT.CANCELLED) {
    return { status: "cancelled" };
  }
  const detail = stderr.trim().split("\n")[0]?.trim() ?? "";
  if (code === PORTRAIT_PICKER_EXIT.UNSUPPORTED) {
    return {
      status: "unsupported",
      reason: detail || PORTRAIT_PICKER_UNSUPPORTED_NOTICE,
    };
  }
  return {
    status: "unavailable",
    reason: detail || PORTRAIT_PICKER_UNAVAILABLE_NOTICE,
  };
}

async function runPortalCommand(
  command: string[],
  env: Record<string, string | undefined>,
): Promise<PortalRunnerResult> {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stdinPipe: ReturnType<typeof Bun.spawn>["stdin"] | null = null;
  let interrupted = false;
  const forwardSignal = () => {
    interrupted = true;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already have exited.
      }
    }
  };
  process.on("SIGTERM", forwardSignal);
  process.on("SIGINT", forwardSignal);
  try {
    // Keep a pipe open on stdin so the kernel delivers HUP to the portal helper
    // even if this process is SIGKILLed (e.g. when the shell unloads the panel).
    child = Bun.spawn(command, {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    stdinPipe = child.stdin;
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (interrupted && code !== PORTRAIT_PICKER_EXIT.PICKED) {
      return { code: PORTRAIT_PICKER_EXIT.CANCELLED, stdout: "", stderr: "" };
    }
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: PORTRAIT_PICKER_EXIT.UNAVAILABLE,
      stdout: "",
      stderr: (error as Error).message,
    };
  } finally {
    process.off("SIGTERM", forwardSignal);
    process.off("SIGINT", forwardSignal);
    if (stdinPipe && typeof stdinPipe !== "number") {
      try {
        stdinPipe.end();
      } catch {
        // Pipe may already be closed.
      }
    }
  }
}

export async function pickPortraitImage(options: {
  home?: string;
  title?: string;
  python?: string;
  scriptPath?: string;
  env?: Record<string, string | undefined>;
  run?: PortalRunner;
} = {}): Promise<PortraitPickerResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  const folder = resolvePortraitStartFolder(home);
  const args = buildPortalPickerArgs({
    title: options.title,
    folder,
    scriptPath: options.scriptPath,
  });
  const runner = options.run ?? runPortalCommand;
  const result = await runner([options.python ?? "python3", ...args], env);
  return parsePortalPickerOutput(result.code, result.stdout, result.stderr);
}
