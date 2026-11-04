import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./sandbox.ts";

test("Restore Default hands back the slot while idle; Stoics can be enabled again", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    // Execute the real host reset command, only in this sandbox. Its launcher
    // is stubbed so no real desktop/screensaver can be started by the test.
    s.put(join(s.env.OMARCHY_PATH, "logo.txt"), "OMARCHY DEFAULT LOGO\n");
    const host = process.env.OMARCHY_TEST_ROOT ?? "/usr/share/omarchy";
    expect((await s.exec(["bash", join(host, "bin/omarchy-branding-screensaver"), "reset"])).code).toBe(0);
    expect((await s.prune()).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("OMARCHY DEFAULT LOGO\n");
    expect(existsSync(join(s.home, "toggle"))).toBe(false);
    expect(existsSync(join(s.home, "omastoic.service.enabled"))).toBe(false);
    expect(existsSync(join(s.home, "omastoic.service.active"))).toBe(false);
    expect((await s.cli(["on"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).not.toBe("OMARCHY DEFAULT LOGO\n");
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("OMARCHY DEFAULT LOGO\n");
  } finally { s.cleanup(); }
}, 10000);

test("a changed displaced-art backup is preserved and failed restore remains retryable", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "original art");
  try {
    expect((await s.cli(["setup", "--on-first", "--quiet"])).code).toBe(0);
    s.put(`${branding}.pre-omastoic`, "user changed backup");
    const failed = await s.cli(["off"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("backup changed or is missing");
    expect(readFileSync(`${branding}.pre-omastoic`, "utf8")).toBe("user changed backup");
    expect(existsSync(join(s.state, "written.sha"))).toBe(true);
    s.put(`${branding}.pre-omastoic`, "original art");
    expect((await s.cli(["off"])).code).toBe(0);
    expect(readFileSync(branding, "utf8")).toBe("original art");
  } finally { s.cleanup(); }
});

test("a conflicting pre-existing backup is never overwritten to enable Stoics", async () => {
  const s = sandbox();
  const branding = join(s.config, "omarchy/branding/screensaver.txt");
  s.put(branding, "my art");
  s.put(`${branding}.pre-omastoic`, "unrelated backup");
  try {
    expect((await s.cli(["on"])).code).toBe(1);
    expect(readFileSync(branding, "utf8")).toBe("my art");
    expect(readFileSync(`${branding}.pre-omastoic`, "utf8")).toBe("unrelated backup");
  } finally { s.cleanup(); }
});
