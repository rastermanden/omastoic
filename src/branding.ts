import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, digest, OwnedFiles, replaceIfUnchanged } from "./files.ts";

export type BrandingSlotOptions = {
  branding: string;
  state: string;
  backup?: string;
  written?: string;
  displaced?: string;
  logo?: string;
  owned?: OwnedFiles;
  setEnabled?: (on: boolean) => void;
  notify?: (message: string) => void;
  logError?: (message: string) => void;
  beforeReplace?: () => void;
};

export type BrandingSlot = {
  branding: string;
  backup: string;
  state: string;
  written: string;
  displaced: string;
  logo: string;
  owned: OwnedFiles;
  setEnabled: (on: boolean) => void;
  notify: (message: string) => void;
  logError: (message: string) => void;
  beforeReplace?: () => void;
};

export function createBrandingSlot(options: BrandingSlotOptions): BrandingSlot {
  return {
    branding: options.branding,
    backup: options.backup ?? `${options.branding}.pre-omastoic`,
    state: options.state,
    written: options.written ?? join(options.state, "written.sha"),
    displaced: options.displaced ?? join(options.state, "displaced.kind"),
    logo: options.logo ?? "",
    owned: options.owned ?? new OwnedFiles(options.state),
    setEnabled: options.setEnabled ?? (() => {}),
    notify: options.notify ?? (() => {}),
    logError: options.logError ?? ((message) => console.error(message)),
    beforeReplace: options.beforeReplace,
  };
}

export function rememberWrite(slot: BrandingSlot, canvas: string): void {
  mkdirSync(slot.state, { recursive: true });
  atomicWrite(slot.written, digest(canvas));
}

/**
 * True when the branding file still holds exactly what omastoic last put there.
 * A missing file is ours only when we recorded that the slot was empty.
 */
export function ownsBranding(slot: BrandingSlot): boolean {
  let expected: string;
  try { expected = readFileSync(slot.written, "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!expected) return false;
  try {
    const stat = lstatSync(slot.branding);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    return digest(readFileSync(slot.branding, "utf8")) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    const kind = existsSync(slot.displaced) ? readFileSync(slot.displaced, "utf8").trim() : "";
    return kind === "absent";
  }
}

/**
 * Someone else has written the screensaver slot. Turn off rather than fight over
 * it so Omarchy's own branding commands win.
 */
export function standAside(slot: BrandingSlot): void {
  slot.setEnabled(false);
  slot.logError("omastoic: the screensaver art changed underneath us — standing aside");
  slot.notify("Screensaver art changed — the Stoics stood aside");
}

/** Replace the branding file in one step, standing aside if a foreign write lands first. */
export async function writeSlot(
  slot: BrandingSlot,
  render: () => Promise<string> | string,
  takeSlot = false,
): Promise<boolean> {
  const before = await Bun.file(slot.branding).text().catch(() => null);
  if (!takeSlot && !ownsBranding(slot)) {
    standAside(slot);
    return false;
  }
  const canvas = await render();
  if ((await Bun.file(slot.branding).text().catch(() => null)) !== before) {
    standAside(slot);
    return false;
  }
  atomicWrite(slot.branding, canvas);
  rememberWrite(slot, canvas);
  return true;
}

/**
 * Keep the art we are about to cover so `off` can put it back. Always the last
 * non-omastoic canvas.
 */
export async function preserveDisplaced(slot: BrandingSlot): Promise<void> {
  const current = Bun.file(slot.branding);
  if (ownsBranding(slot) && await Bun.file(slot.displaced).exists()) return;
  if (!(await current.exists())) {
    atomicWrite(slot.displaced, "absent");
    return;
  }
  const text = await current.text();
  slot.owned.write("backup", slot.backup, text);
  atomicWrite(slot.displaced, "file");
}

function leaveChangedBranding(slot: BrandingSlot): void {
  slot.logError("omastoic: the screensaver file changed after we wrote it — leaving it in place and keeping the backup");
}

function restorationText(slot: BrandingSlot, source: string): string {
  const text = readFileSync(source, "utf8");
  slot.beforeReplace?.();
  return text;
}

export async function restoreSlot(slot: BrandingSlot): Promise<void> {
  if (!(await Bun.file(slot.displaced).exists()) && !(await Bun.file(slot.written).exists())) return;
  if (!ownsBranding(slot)) {
    leaveChangedBranding(slot);
    return;
  }
  const expected = readFileSync(slot.written, "utf8").trim();
  const kind = await Bun.file(slot.displaced).text().catch(() => "legacy");
  let restored = false;
  if (kind === "absent") {
    if (!discardBranding(slot)) {
      leaveChangedBranding(slot);
      return;
    }
    restored = true;
  } else if (existsSync(slot.backup) && slot.owned.owns("backup", slot.backup)) {
    const text = restorationText(slot, slot.backup);
    restored = replaceIfUnchanged(slot.branding, expected, text);
    if (!restored) {
      leaveChangedBranding(slot);
      return;
    }
  } else if (kind === "file") {
    throw new Error(`displaced branding backup changed or is missing: ${slot.backup}; restore the backup before retrying off/uninstall`);
  } else if (kind === "legacy" && slot.logo && existsSync(slot.logo)) {
    const text = restorationText(slot, slot.logo);
    restored = replaceIfUnchanged(slot.branding, expected, text);
    if (!restored) {
      leaveChangedBranding(slot);
      return;
    }
  }
  if (!restored) return;
  slot.owned.remove("backup", slot.backup);
  rmSync(slot.displaced, { force: true });
  rmSync(slot.written, { force: true });
}

/**
 * Remove the canvas we wrote into an empty slot. A symlink is removed itself
 * when it still resolves to those exact bytes, so the link cannot dangle and
 * the file it names is left alone.
 */
function discardBranding(slot: BrandingSlot): boolean {
  const absent = (error: unknown): boolean => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  };
  let stat;
  try { stat = lstatSync(slot.branding); }
  catch (error) { return absent(error); }
  if (!ownsBranding(slot)) return false;
  if (stat.isSymbolicLink()) {
    let again;
    try { again = lstatSync(slot.branding); }
    catch (error) { return absent(error); }
    if (!again.isSymbolicLink() || !ownsBranding(slot)) return false;
    unlinkSync(slot.branding);
    return true;
  }
  if (!stat.isFile()) return false;
  let again;
  try { again = lstatSync(slot.branding); }
  catch (error) { return absent(error); }
  if (!again.isFile() || !ownsBranding(slot)) return false;
  rmSync(slot.branding);
  return true;
}
