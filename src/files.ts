// Small local transactions shared by CLI commands and daemon writes.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Where the bytes should land. A symlink stays a symlink; we write its target. */
function writeDestination(path: string): string {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    if (!stat.isFile()) throw new Error(`refusing to replace non-file: ${path}`);
    return path;
  }
  let target: string;
  try { target = realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`refusing to replace dangling symlink: ${path}`);
    throw error;
  }
  if (!lstatSync(target).isFile()) throw new Error(`refusing to follow symlink to a non-file: ${path}`);
  return target;
}

export function atomicWrite(path: string, text: string): void {
  const destination = writeDestination(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.omastoic-${randomUUID()}`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, destination);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Replace `path` with `nextText` only if its current bytes still hash to
 * `expectedDigest`. The temp file is in the target's directory (the symlink
 * target, when `path` is a link). A mismatch or a short copy leaves `path`
 * untouched and returns false or throws before any rename.
 */
export function replaceIfUnchanged(path: string, expectedDigest: string, nextText: string): boolean {
  const matches = (): boolean => {
    try { return digest(readFileSync(path, "utf8")) === expectedDigest; }
    catch { return false; }
  };
  if (!matches()) return false;
  const destination = writeDestination(path);
  const temp = `${destination}.omastoic-${randomUUID()}`;
  const bytes = Buffer.from(nextText, "utf8");
  const fd = openSync(temp, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset);
      if (wrote <= 0) throw new Error("could not copy the screensaver backup");
      offset += wrote;
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  const copied = readFileSync(temp);
  if (!copied.equals(bytes)) {
    rmSync(temp, { force: true });
    throw new Error("screensaver backup copy was incomplete");
  }
  if (!matches()) {
    rmSync(temp, { force: true });
    return false;
  }
  try {
    renameSync(temp, destination);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

export async function locked<T>(state: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(state, { recursive: true });
  const holder = Bun.spawn(["flock", "--exclusive", "--wait", "15", "--no-fork", join(state, "transaction.flock"), "sh", "-c", "printf x; cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  try {
    const reader = holder.stdout.getReader();
    const { done } = await reader.read();
    reader.releaseLock();
    if (done) throw new Error("could not acquire the omastoic transaction lock; retry shortly");
    return await action();
  } finally {
    holder.stdin.end();
    await holder.exited;
  }
}

export class OwnedFiles {
  constructor(private state: string) {}
  private record(id: string) { return join(this.state, "owned", id); }
  owns(id: string, path: string): boolean {
    try { return lstatSync(path).isFile() && readFileSync(this.record(id), "utf8").trim() === digest(readFileSync(path, "utf8")); }
    catch { return false; }
  }
  check(id: string, path: string, body: string, legacy?: string): void {
    let stat;
    try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    const previousPrune = id === "prune-script" && digest(readFileSync(path, "utf8")) === "8eb4229da677439174345cef68e4486b4ce8895d1fadeaddad92445136d904dd";
    if (stat.isFile() && (this.owns(id, path) || readFileSync(path, "utf8") === body || previousPrune || (legacy != null && readFileSync(path, "utf8") === legacy))) return;
    throw new Error(`refusing to overwrite unrelated file: ${path}`);
  }
  write(id: string, path: string, body: string, legacy?: string): boolean {
    this.check(id, path, body, legacy);
    const changed = !existsSync(path) || readFileSync(path, "utf8") !== body;
    if (changed) atomicWrite(path, body);
    atomicWrite(this.record(id), digest(body));
    return changed;
  }
  remove(id: string, path: string): void {
    if (this.owns(id, path)) rmSync(path);
    rmSync(this.record(id), { force: true });
  }
}
