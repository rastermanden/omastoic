// Small local transactions shared by CLI commands and daemon writes.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
