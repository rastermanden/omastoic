import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createBrandingSlot,
  ownsBranding,
  preserveDisplaced,
  rememberWrite,
  restoreSlot,
  standAside,
  writeSlot,
} from "../src/branding.ts";

function fakeSlot(extra: { logoText?: string; beforeReplace?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omastoic-branding-"));
  const branding = join(dir, "config/omarchy/branding/screensaver.txt");
  const state = join(dir, "state/omastoic");
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  let logo: string | undefined;
  if (extra.logoText !== undefined) {
    logo = join(dir, "host/logo.txt");
    put(logo, extra.logoText);
  }
  const events: { enabled: boolean[]; notices: string[]; errors: string[] } = {
    enabled: [],
    notices: [],
    errors: [],
  };
  const slot = createBrandingSlot({
    branding,
    state,
    logo,
    beforeReplace: extra.beforeReplace,
    setEnabled: (on) => events.enabled.push(on),
    notify: (message) => events.notices.push(message),
    logError: (message) => events.errors.push(message),
  });
  return {
    dir,
    slot,
    events,
    put,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("branding slot helpers", () => {
  test("first cover of a foreign branding file writes a backup and claims ownership", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "foreign screensaver art\n");
      expect(ownsBranding(f.slot)).toBe(false);

      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.backup, "utf8")).toBe("foreign screensaver art\n");
      expect(f.slot.owned.owns("backup", f.slot.backup)).toBe(true);
      expect(readFileSync(f.slot.displaced, "utf8")).toBe("file");

      const wrote = await writeSlot(f.slot, () => "stoic canvas 1\n", true);
      expect(wrote).toBe(true);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("stoic canvas 1\n");
      expect(ownsBranding(f.slot)).toBe(true);
      expect(readFileSync(f.slot.backup, "utf8")).toBe("foreign screensaver art\n");
    } finally { f.cleanup(); }
  });

  test("covering a canvas that is already ours does not overwrite the backup", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      expect(ownsBranding(f.slot)).toBe(true);

      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
      expect(readFileSync(f.slot.displaced, "utf8")).toBe("file");

      expect(await writeSlot(f.slot, () => "stoic canvas 2\n")).toBe(true);
      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
      expect(readFileSync(f.slot.branding, "utf8")).toBe("stoic canvas 2\n");
    } finally { f.cleanup(); }
  });

  test("covering our own canvas in an originally empty slot keeps displaced absent and writes no backup", async () => {
    const f = fakeSlot();
    try {
      expect(existsSync(f.slot.branding)).toBe(false);
      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.displaced, "utf8")).toBe("absent");
      expect(existsSync(f.slot.backup)).toBe(false);

      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      expect(ownsBranding(f.slot)).toBe(true);

      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.displaced, "utf8")).toBe("absent");
      expect(existsSync(f.slot.backup)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("preserveDisplaced refuses to overwrite an unrelated pre-existing backup", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "user art\n");
      f.put(f.slot.backup, "unrelated backup\n");

      await expect(preserveDisplaced(f.slot)).rejects.toThrow("refusing to overwrite unrelated file");
      expect(readFileSync(f.slot.branding, "utf8")).toBe("user art\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("unrelated backup\n");
      expect(existsSync(f.slot.displaced)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("restoreSlot puts back the backup and clears ownership state, and is idempotent", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);

      await restoreSlot(f.slot);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("original user art\n");
      expect(existsSync(f.slot.backup)).toBe(false);
      expect(existsSync(f.slot.displaced)).toBe(false);
      expect(existsSync(f.slot.written)).toBe(false);
      expect(ownsBranding(f.slot)).toBe(false);

      await restoreSlot(f.slot);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("original user art\n");
      expect(f.events.errors).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("restoreSlot removes our canvas when the slot was originally absent", async () => {
    const f = fakeSlot();
    try {
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      expect(existsSync(f.slot.branding)).toBe(true);

      await restoreSlot(f.slot);
      expect(existsSync(f.slot.branding)).toBe(false);
      expect(existsSync(f.slot.displaced)).toBe(false);
      expect(existsSync(f.slot.written)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("restoreSlot keeps a branding symlink and restores its target", async () => {
    const f = fakeSlot();
    try {
      const target = join(f.dir, "real-branding.txt");
      f.put(target, "symlinked foreign art\n");
      mkdirSync(dirname(f.slot.branding), { recursive: true });
      symlinkSync(target, f.slot.branding);

      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      expect(lstatSync(f.slot.branding).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("stoic canvas 1\n");
      expect(ownsBranding(f.slot)).toBe(true);

      await restoreSlot(f.slot);
      expect(lstatSync(f.slot.branding).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("symlinked foreign art\n");
      expect(existsSync(f.slot.backup)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("covering a foreign write replaces our owned backup with the newer foreign art", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "first foreign art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);

      f.put(f.slot.branding, "second foreign art\n");
      expect(ownsBranding(f.slot)).toBe(false);
      await preserveDisplaced(f.slot);
      expect(readFileSync(f.slot.backup, "utf8")).toBe("second foreign art\n");

      expect(await writeSlot(f.slot, () => "stoic canvas 2\n", true)).toBe(true);
      await restoreSlot(f.slot);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("second foreign art\n");
      expect(existsSync(f.slot.backup)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("restoreSlot restores the legacy host logo when displaced.kind is missing", async () => {
    const f = fakeSlot({ logoText: "HOST DEFAULT LOGO\n" });
    try {
      f.put(f.slot.branding, "stoic canvas 1\n");
      rememberWrite(f.slot, "stoic canvas 1\n");

      await restoreSlot(f.slot);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("HOST DEFAULT LOGO\n");
      expect(existsSync(f.slot.written)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("restoreSlot throws and preserves both files when the backup was modified", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      f.put(f.slot.backup, "user edited backup\n");

      await expect(restoreSlot(f.slot)).rejects.toThrow("backup changed or is missing");
      expect(readFileSync(f.slot.branding, "utf8")).toBe("stoic canvas 1\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("user edited backup\n");
      expect(existsSync(f.slot.written)).toBe(true);
      expect(existsSync(f.slot.displaced)).toBe(true);
    } finally { f.cleanup(); }
  });

  test("standAside disables the toggle, logs, notifies, and leaves branding and backup untouched", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      f.put(f.slot.branding, "newer foreign art\n");

      standAside(f.slot);
      expect(f.events.enabled).toEqual([false]);
      expect(f.events.errors).toEqual(["omastoic: the screensaver art changed underneath us — standing aside"]);
      expect(f.events.notices).toEqual(["Screensaver art changed — the Stoics stood aside"]);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("newer foreign art\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
      expect(existsSync(f.slot.written)).toBe(true);
    } finally { f.cleanup(); }
  });

  test("a foreign write causes writeSlot to stand aside without rendering or clobbering file or backup", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      f.put(f.slot.branding, "foreign replacement\n");

      expect(ownsBranding(f.slot)).toBe(false);
      let rendered = false;
      const wrote = await writeSlot(f.slot, () => {
        rendered = true;
        return "stoic canvas 2\n";
      });
      expect(wrote).toBe(false);
      expect(rendered).toBe(false);
      expect(f.events.enabled).toEqual([false]);
      expect(f.events.notices).toEqual(["Screensaver art changed — the Stoics stood aside"]);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("foreign replacement\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
    } finally { f.cleanup(); }
  });

  test("a foreign write during rendering stands aside even when takeSlot is true", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);

      const wrote = await writeSlot(
        f.slot,
        () => {
          f.put(f.slot.branding, "concurrent foreign art\n");
          return "stoic canvas 1\n";
        },
        true,
      );
      expect(wrote).toBe(false);
      expect(f.events.enabled).toEqual([false]);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("concurrent foreign art\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
      expect(existsSync(f.slot.written)).toBe(false);
    } finally { f.cleanup(); }
  });

  test("restoreSlot leaves a foreign write and its backup alone, including a race right before swap", async () => {
    const f = fakeSlot();
    try {
      f.put(f.slot.branding, "original user art\n");
      await preserveDisplaced(f.slot);
      expect(await writeSlot(f.slot, () => "stoic canvas 1\n", true)).toBe(true);
      f.put(f.slot.branding, "foreign art\n");

      await restoreSlot(f.slot);
      expect(readFileSync(f.slot.branding, "utf8")).toBe("foreign art\n");
      expect(readFileSync(f.slot.backup, "utf8")).toBe("original user art\n");
      expect(existsSync(f.slot.written)).toBe(true);
      expect(existsSync(f.slot.displaced)).toBe(true);
      expect(f.events.errors.at(-1)).toContain("leaving it in place");
    } finally { f.cleanup(); }

    const raced = fakeSlot({
      beforeReplace: () => {
        writeFileSync(raced.slot.branding, "raced foreign art\n");
      },
    });
    try {
      raced.put(raced.slot.branding, "original user art\n");
      await preserveDisplaced(raced.slot);
      expect(await writeSlot(raced.slot, () => "stoic canvas 1\n", true)).toBe(true);

      await restoreSlot(raced.slot);
      expect(readFileSync(raced.slot.branding, "utf8")).toBe("raced foreign art\n");
      expect(readFileSync(raced.slot.backup, "utf8")).toBe("original user art\n");
      expect(existsSync(raced.slot.written)).toBe(true);
      expect(existsSync(raced.slot.displaced)).toBe(true);
      expect(raced.events.errors.at(-1)).toContain("leaving it in place");
    } finally { raced.cleanup(); }
  });

  test("ownsBranding handles missing records, empty hashes, directories, and deleted slots", async () => {
    const f = fakeSlot();
    try {
      expect(ownsBranding(f.slot)).toBe(false);

      f.put(f.slot.written, "\n");
      f.put(f.slot.branding, "anything\n");
      expect(ownsBranding(f.slot)).toBe(false);

      rememberWrite(f.slot, "stoic canvas\n");
      f.put(f.slot.branding, "stoic canvas\n");
      expect(ownsBranding(f.slot)).toBe(true);

      f.put(f.slot.displaced, "file");
      rmSync(f.slot.branding);
      expect(ownsBranding(f.slot)).toBe(false);

      f.put(f.slot.displaced, "absent");
      expect(ownsBranding(f.slot)).toBe(true);

      mkdirSync(f.slot.branding, { recursive: true });
      expect(ownsBranding(f.slot)).toBe(false);
    } finally { f.cleanup(); }
  });
});
