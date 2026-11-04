// Small local transactions shared by CLI commands and daemon writes. The Bash
// removal watcher takes the same mkdir lock, so it cannot prune mid-setup.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.omastoic-${randomUUID()}`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function locked<T>(state: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(state, { recursive: true });
  const lock = join(state, "transaction.lock");
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") { rmSync(lock, { recursive: true, force: true }); continue; }
          }
        }
      } catch {
        // A crash between mkdir and writing pid must not wedge future setup.
        try { if (Date.now() - statSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      }
      if (Date.now() >= deadline) throw new Error("another omastoic command is busy; retry shortly");
      await Bun.sleep(25);
    }
  }
  try { return await action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
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
