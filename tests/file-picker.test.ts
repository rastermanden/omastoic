import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  buildPortalPickerArgs,
  parsePortalPickerOutput,
  pickPortraitImage,
  PORTRAIT_PICKER_EXIT,
  PORTRAIT_PICKER_TITLE,
  PORTRAIT_PICKER_UNAVAILABLE_NOTICE,
  PORTRAIT_PICKER_UNSUPPORTED_NOTICE,
  resolvePortraitStartFolder,
} from "../src/file-picker.ts";
import { root, sandbox } from "./sandbox.ts";

function makePng(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = pixel(x, y);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePortraitPng(path: string): void {
  const png = makePng(68, 80, (x, y) => {
    const dx = x - 34;
    const dy = y - 34;
    const head = dx * dx + dy * dy < 20 * 20;
    const shoulders = y >= 54 && y <= 76 && Math.abs(x - 34) < 26;
    return head || shoulders ? 20 : 250;
  });
  writeFileSync(path, png);
}

test("resolvePortraitStartFolder prefers ~/Pictures when it is a directory and falls back to $HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "omastoic-picker-home-"));
  try {
    expect(resolvePortraitStartFolder(home)).toBe(home);

    const pictures = join(home, "Pictures");
    writeFileSync(pictures, "not a directory\n");
    expect(resolvePortraitStartFolder(home)).toBe(home);

    rmSync(pictures);
    mkdirSync(pictures);
    expect(resolvePortraitStartFolder(home)).toBe(pictures);

    expect(resolvePortraitStartFolder(join(home, "does-not-exist"))).toBeNull();
    expect(resolvePortraitStartFolder("")).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildPortalPickerArgs and parsePortalPickerOutput handle picked, cancelled, and unavailable outcomes", () => {
  expect(buildPortalPickerArgs({ folder: "/tmp/Pictures", scriptPath: "/app/picker.py" })).toEqual([
    "/app/picker.py",
    "--title",
    PORTRAIT_PICKER_TITLE,
    "--folder",
    "/tmp/Pictures",
  ]);
  expect(buildPortalPickerArgs({ folder: null, scriptPath: "/app/picker.py" })).toEqual([
    "/app/picker.py",
    "--title",
    PORTRAIT_PICKER_TITLE,
  ]);

  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.PICKED, "/tmp/Pictures/Marcus Aurelius.png\n", "")).toEqual({
    status: "picked",
    path: "/tmp/Pictures/Marcus Aurelius.png",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.PICKED, "  /tmp/leading space.png  \n", "")).toEqual({
    status: "picked",
    path: "  /tmp/leading space.png  ",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.PICKED, "\n", "")).toEqual({
    status: "cancelled",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.PICKED, "/tmp/a\n/tmp/b\n", "")).toEqual({
    status: "unsupported",
    reason: PORTRAIT_PICKER_UNSUPPORTED_NOTICE,
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.CANCELLED, "", "")).toEqual({
    status: "cancelled",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.UNSUPPORTED, "", "selected file is not a local path")).toEqual({
    status: "unsupported",
    reason: "selected file is not a local path",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.UNSUPPORTED, "", "")).toEqual({
    status: "unsupported",
    reason: PORTRAIT_PICKER_UNSUPPORTED_NOTICE,
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.UNAVAILABLE, "", "portal offline\nmore detail")).toEqual({
    status: "unavailable",
    reason: "portal offline",
  });
  expect(parsePortalPickerOutput(PORTRAIT_PICKER_EXIT.UNAVAILABLE, "", "")).toEqual({
    status: "unavailable",
    reason: PORTRAIT_PICKER_UNAVAILABLE_NOTICE,
  });
});

test("pickPortraitImage passes ~/Pictures and handles missing interpreter without throwing", async () => {
  const home = mkdtempSync(join(tmpdir(), "omastoic-picker-run-"));
  const pictures = join(home, "Pictures");
  mkdirSync(pictures);
  try {
    let seenCommand: string[] = [];
    const picked = await pickPortraitImage({
      home,
      run: async (command) => {
        seenCommand = command;
        return { code: 0, stdout: `${join(pictures, "seneca.jpg")}\n`, stderr: "" };
      },
    });
    expect(seenCommand[0]).toBe("python3");
    expect(seenCommand).toContain("--title");
    expect(seenCommand).toContain(PORTRAIT_PICKER_TITLE);
    expect(seenCommand).toContain("--folder");
    expect(seenCommand).toContain(pictures);
    expect(picked).toEqual({ status: "picked", path: join(pictures, "seneca.jpg") });

    const missing = await pickPortraitImage({
      home,
      python: join(home, "no-such-python"),
    });
    expect(missing.status).toBe("unavailable");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("panel pick-image --help exits 0 without touching D-Bus or state, and exits 2 when no bus is available", async () => {
  const s = sandbox();
  try {
    for (const flag of ["--help", "-h"]) {
      const help = await s.cli(["panel", "pick-image", flag], {
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(s.home, "missing-bus.sock")}`,
      });
      expect(help.code).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("omastoic panel pick-image");
    }
    const result = await s.cli(["panel", "pick-image"], {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(s.home, "missing-bus.sock")}`,
    });
    expect(result.code).toBe(PORTRAIT_PICKER_EXIT.UNAVAILABLE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("omastoic:");
    expect(readFileSync(join(root, "src/portrait.ts"), "utf8")).toContain("MAX_IMAGE_BYTES = 20 * 1024 * 1024");
  } finally {
    s.cleanup();
  }
});

const hasDbusAndGi = Boolean(
  Bun.which("dbus-run-session") &&
    Bun.spawnSync(["python3", "-c", "import gi; gi.require_version('Gio', '2.0'); from gi.repository import Gio, GLib"]).exitCode === 0,
);

const MOCK_PORTAL_DRIVER = `#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import threading
import time

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

INTROSPECTION_XML = """
<node>
  <interface name="org.freedesktop.portal.FileChooser">
    <method name="OpenFile">
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
  </interface>
</node>
"""

REQUEST_XML = """
<node>
  <interface name="org.freedesktop.portal.Request">
    <method name="Close"/>
  </interface>
</node>
"""

FAKE_SHELL_SCRIPT = """
import os, subprocess, sys, time
pid_file = sys.argv[1]
use_pipe = sys.argv[2] == "pipe"
child_cmd = sys.argv[3:]
stdin_arg = subprocess.PIPE if use_pipe else subprocess.DEVNULL
proc = subprocess.Popen(child_cmd, stdin=stdin_arg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(proc.pid))
    fh.flush()
while True:
    time.sleep(60)
"""

def wait_for_pid_exit(pid, timeout_sec=5.0):
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(0.05)
    return False

def main():
    spec_path = sys.argv[1]
    out_path = sys.argv[2]
    cmd = sys.argv[3:]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
    req_node = Gio.DBusNodeInfo.new_for_xml(REQUEST_XML)
    loop = GLib.MainLoop()
    recorded = {"calls": [], "closedHandles": [], "grandchildExited": None}
    result_holder = {}
    child_holder = {"proc": None}

    def on_request_call(_connection, _sender, object_path, _interface_name, method_name, _parameters, invocation):
        if method_name == "Close":
            recorded["closedHandles"].append(object_path)
            invocation.return_value(None)
            if spec.get("waitForClose"):
                if spec.get("parentShellKill"):
                    def finish_after_exit():
                        pid_file = spec["grandchildPidFile"]
                        try:
                            with open(pid_file, "r", encoding="utf-8") as fh:
                                grandchild_pid = int(fh.read().strip())
                            recorded["grandchildExited"] = wait_for_pid_exit(grandchild_pid)
                        except Exception:
                            recorded["grandchildExited"] = False
                        GLib.idle_add(loop.quit)
                    threading.Thread(target=finish_after_exit, daemon=True).start()
                else:
                    GLib.idle_add(loop.quit)

    def on_method_call(connection, sender, object_path, interface_name, method_name, parameters, invocation):
        parent_window, title, options = parameters.unpack()
        options_variant = parameters.get_child_value(2)
        folder_bytes = None
        for i in range(options_variant.n_children()):
            entry = options_variant.get_child_value(i)
            key = entry.get_child_value(0).get_string()
            if key == "current_folder":
                val = entry.get_child_value(1).get_variant()
                folder_bytes = list(val.get_data_as_bytes().get_data())
        token = options.get("handle_token", "fallback")
        sender_id = sender[1:].replace(".", "_")
        handle = spec.get("customHandle") or f"/org/freedesktop/portal/desktop/request/{sender_id}/{token}"
        bus.register_object(handle, req_node.interfaces[0], on_request_call, None, None)
        recorded["calls"].append({
            "parent_window": parent_window,
            "title": title,
            "multiple": options.get("multiple"),
            "filters": options.get("filters"),
            "current_filter": options.get("current_filter"),
            "current_folder_bytes": folder_bytes,
            "handle": handle,
        })
        invocation.return_value(GLib.Variant("(o)", (handle,)))

        kill_sig = spec.get("killSignal")
        if kill_sig:
            def send_kill():
                proc = child_holder["proc"]
                if proc is not None and proc.poll() is None:
                    proc.send_signal(getattr(signal, kill_sig))
                return GLib.SOURCE_REMOVE
            GLib.timeout_add(150, send_kill)
            return

        def send_response():
            response_code = int(spec["responseCode"])
            results = {}
            if spec.get("uris"):
                results["uris"] = GLib.Variant("as", spec["uris"])
            connection.emit_signal(
                sender,
                handle,
                "org.freedesktop.portal.Request",
                "Response",
                GLib.Variant("(ua{sv})", (response_code, results)),
            )
            return GLib.SOURCE_REMOVE

        GLib.timeout_add(50, send_response)

    def run_child_thread():
        if spec.get("parentShellKill"):
            pid_file = spec["grandchildPidFile"]
            pipe_mode = "pipe" if spec.get("parentShellPipe") else "devnull"
            proc = subprocess.Popen(
                [sys.executable, "-c", FAKE_SHELL_SCRIPT, pid_file, pipe_mode, *cmd],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            child_holder["proc"] = proc
            stdout, stderr = proc.communicate()
            result_holder["code"] = proc.returncode
            result_holder["stdout"] = stdout
            result_holder["stderr"] = stderr
            return

        stdin_mode = subprocess.DEVNULL if spec.get("devnullStdin") else subprocess.PIPE
        proc = subprocess.Popen(cmd, stdin=stdin_mode, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child_holder["proc"] = proc
        stdout, stderr = proc.communicate()
        result_holder["code"] = proc.returncode
        result_holder["stdout"] = stdout
        result_holder["stderr"] = stderr
        if not spec.get("waitForClose"):
            GLib.idle_add(loop.quit)

    def start_child():
        threading.Thread(target=run_child_thread, daemon=True).start()
        return GLib.SOURCE_REMOVE

    def on_name_acquired(_connection, _name):
        GLib.idle_add(start_child)

    def on_name_lost(_connection, _name):
        result_holder["code"] = 99
        result_holder["stderr"] = "could not own org.freedesktop.portal.Desktop"
        loop.quit()

    if spec.get("exposePortal", True):
        bus.register_object(
            "/org/freedesktop/portal/desktop",
            node.interfaces[0],
            on_method_call,
            None,
            None,
        )
        Gio.bus_own_name_on_connection(
            bus,
            "org.freedesktop.portal.Desktop",
            Gio.BusNameOwnerFlags.NONE,
            on_name_acquired,
            on_name_lost,
        )
    else:
        GLib.idle_add(start_child)

    GLib.timeout_add_seconds(15, loop.quit)
    loop.run()

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"recorded": recorded, "child": result_holder}, fh)

if __name__ == "__main__":
    main()
`;

const ISOLATED_DBUS_CONF = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

async function runWithMockPortal(
  s: ReturnType<typeof sandbox>,
  spec: {
    exposePortal?: boolean;
    responseCode?: number;
    uris?: string[];
    customHandle?: string;
    killSignal?: "SIGTERM" | "SIGKILL";
    waitForClose?: boolean;
    devnullStdin?: boolean;
    directPythonHelper?: boolean;
    watchStdin?: boolean;
    parentShellKill?: boolean;
    parentShellPipe?: boolean;
    grandchildPidFile?: string;
  },
) {
  const driver = join(s.home, "mock-portal-driver.py");
  const specPath = join(s.home, "portal-spec.json");
  const outPath = join(s.home, "portal-out.json");
  const dbusConf = join(s.home, "isolated-dbus.conf");
  writeFileSync(driver, MOCK_PORTAL_DRIVER);
  chmodSync(driver, 0o755);
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(dbusConf, ISOLATED_DBUS_CONF);

  const targetCmd = spec.directPythonHelper
    ? ["python3", join(root, "scripts/portal-pick-image.py"), "--title", PORTRAIT_PICKER_TITLE]
    : [
        process.execPath,
        join(root, "src/cli.ts"),
        "panel",
        "pick-image",
        ...(spec.watchStdin ? ["--watch-stdin"] : []),
      ];

  const run = await s.exec([
    "dbus-run-session",
    "--config-file",
    dbusConf,
    "--",
    "python3",
    driver,
    specPath,
    outPath,
    ...targetCmd,
  ]);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(readFileSync(outPath, "utf8")) as {
    recorded: {
      calls: Array<{
        parent_window: string;
        title: string;
        multiple: boolean;
        filters: Array<[string, Array<[number, string]>]>;
        current_filter: [string, Array<[number, string]>];
        current_folder_bytes: number[] | null;
        handle: string;
      }>;
      closedHandles: string[];
      grandchildExited: boolean | null;
    };
    child: { code: number; stdout: string; stderr: string };
  };
}

test("panel pick-image speaks xdg-desktop-portal FileChooser over D-Bus, filters JPEG/PNG, defaults to ~/Pictures, and feeds panel apply validation", async () => {
  if (!hasDbusAndGi) {
    console.log("skipping live mock-D-Bus portal test: dbus-run-session or python3 gi unavailable");
    return;
  }

  const s = sandbox();
  try {
    const pictures = join(s.home, "Pictures");
    mkdirSync(pictures, { recursive: true });
    const portraitFile = join(pictures, "Musonius Portrait.png");
    writePortraitPng(portraitFile);
    const badFile = join(pictures, "not-an-image.txt");
    writeFileSync(badFile, "plain text\n");

    // 1. Accepted file with spaces in ~/Pictures: verifies D-Bus options, filter, current_folder, and URI decoding.
    const pickedUri = `file://${encodeURI(portraitFile)}`;
    const accepted = await runWithMockPortal(s, { responseCode: 0, uris: [pickedUri] });
    expect(accepted.child.code).toBe(PORTRAIT_PICKER_EXIT.PICKED);
    expect(accepted.child.stderr).toBe("");
    expect(accepted.child.stdout).toBe(`${portraitFile}\n`);

    expect(accepted.recorded.calls).toHaveLength(1);
    const call = accepted.recorded.calls[0]!;
    expect(call.title).toBe(PORTRAIT_PICKER_TITLE);
    expect(call.multiple).toBe(false);
    expect(call.filters).toHaveLength(1);
    const [label, rules] = call.filters[0]!;
    expect(label).toBe("JPEG and PNG images");
    expect(rules).toContainEqual([1, "image/jpeg"]);
    expect(rules).toContainEqual([1, "image/png"]);
    expect(rules).toContainEqual([0, "*.jpg"]);
    expect(rules).toContainEqual([0, "*.jpeg"]);
    expect(rules).toContainEqual([0, "*.png"]);
    expect(rules).toContainEqual([0, "*.JPG"]);
    expect(rules).toContainEqual([0, "*.JPEG"]);
    expect(rules).toContainEqual([0, "*.PNG"]);
    expect(call.current_filter).toEqual(call.filters[0]!);
    expect(call.current_folder_bytes).toEqual([...Buffer.from(pictures), 0]);

    // 2. Chosen path flows through existing panel apply addAuthor & src/portrait.ts validation.
    const added = await s.cli([
      "panel",
      "apply",
      JSON.stringify({
        addAuthor: {
          slug: "musonius",
          name: "Musonius Rufus",
          dates: "c. AD 30 – 100",
          image: accepted.child.stdout.replace(/\r?\n$/, ""),
          citation: "Lectures VI",
          text: "We will train both soul and body.",
        },
      }),
    ]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout).samples.some((a: { slug: string }) => a.slug === "musonius")).toBe(true);

    // 3. Invalid file chosen through picker is still rejected by src/portrait.ts on replaceAuthor.
    const badPicked = await runWithMockPortal(s, { responseCode: 0, uris: [`file://${encodeURI(badFile)}`] });
    expect(badPicked.child.code).toBe(PORTRAIT_PICKER_EXIT.PICKED);
    const rejected = await s.cli([
      "panel",
      "apply",
      JSON.stringify({
        replaceAuthor: {
          slug: "musonius",
          image: badPicked.child.stdout.replace(/\r?\n$/, ""),
        },
      }),
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("JPEG or PNG");

    // 4. Cancelled portal response (code 1) exits 1 with no output.
    const cancelled = await runWithMockPortal(s, { responseCode: 1, uris: [] });
    expect(cancelled.child.code).toBe(PORTRAIT_PICKER_EXIT.CANCELLED);
    expect(cancelled.child.stdout).toBe("");
    expect(cancelled.child.stderr).toBe("");

    // 5. Portal failure response (code 2) exits 2 (unavailable) with stderr.
    const endedOther = await runWithMockPortal(s, { responseCode: 2, uris: [] });
    expect(endedOther.child.code).toBe(PORTRAIT_PICKER_EXIT.UNAVAILABLE);
    expect(endedOther.child.stdout).toBe("");
    expect(endedOther.child.stderr).toContain("omastoic:");

    // 6. Fallback subscription when portal returns handle != predicted still delivers Response.
    const customHandle = "/org/freedesktop/portal/desktop/request/legacy/custom_req";
    const legacy = await runWithMockPortal(s, { responseCode: 0, uris: [pickedUri], customHandle });
    expect(legacy.child.code).toBe(PORTRAIT_PICKER_EXIT.PICKED);
    expect(legacy.child.stdout).toBe(`${portraitFile}\n`);

    // 7. Non-local and unsupported URIs (https://, remote file://, embedded newline, non-UTF-8 bytes) exit 3 (UNSUPPORTED), not 2 (UNAVAILABLE).
    for (const remoteUri of [
      "https://example.com/portrait.png",
      "file://other-host/share/portrait.png",
      "file:///tmp/bad%0Aname.png",
      "file:///tmp/bad%FFname.png",
    ]) {
      const remote = await runWithMockPortal(s, { responseCode: 0, uris: [remoteUri] });
      expect(remote.child.code, remoteUri).toBe(PORTRAIT_PICKER_EXIT.UNSUPPORTED);
      expect(remote.child.stdout, remoteUri).toBe("");
      expect(remote.child.stderr, remoteUri).toContain("omastoic:");
    }

    // 8. SIGTERM to `omastoic panel pick-image` forwards to Python helper and calls Request.Close.
    const terminated = await runWithMockPortal(s, { killSignal: "SIGTERM" });
    expect(terminated.child.code).toBe(PORTRAIT_PICKER_EXIT.CANCELLED);
    expect(terminated.recorded.closedHandles).toEqual([terminated.recorded.calls[0]!.handle]);

    // 9. SIGKILL to `omastoic panel pick-image` (mimicking QProcess::~QProcess on panel unload)
    //    closes the stdin pipe; portal-pick-image.py detects HUP and still calls Request.Close.
    const killed = await runWithMockPortal(s, { killSignal: "SIGKILL", waitForClose: true });
    expect(killed.recorded.calls).toHaveLength(1);
    expect(killed.recorded.closedHandles).toEqual([killed.recorded.calls[0]!.handle]);

    // 9b. Parent shell dying (SIGKILL reparenting bun to init/subreaper, without --watch-stdin):
    //     bun detects process.ppid change, cancels portal-pick-image.py, Request.Close runs, and bun exits.
    const parentDiedReparent = await runWithMockPortal(s, {
      killSignal: "SIGKILL",
      waitForClose: true,
      parentShellKill: true,
      parentShellPipe: false,
      grandchildPidFile: join(s.home, "bun-reparent.pid"),
    });
    expect(parentDiedReparent.recorded.calls).toHaveLength(1);
    expect(parentDiedReparent.recorded.closedHandles).toEqual([parentDiedReparent.recorded.calls[0]!.handle]);
    expect(parentDiedReparent.recorded.grandchildExited).toBe(true);

    // 9c. Parent shell dying with Quickshell's stdinEnabled pipe + --watch-stdin:
    //     bun detects stdin pipe EOF immediately, cancels portal-pick-image.py, Request.Close runs, and bun exits.
    const parentDiedStdin = await runWithMockPortal(s, {
      killSignal: "SIGKILL",
      waitForClose: true,
      watchStdin: true,
      parentShellKill: true,
      parentShellPipe: true,
      grandchildPidFile: join(s.home, "bun-stdin.pid"),
    });
    expect(parentDiedStdin.recorded.calls).toHaveLength(1);
    expect(parentDiedStdin.recorded.closedHandles).toEqual([parentDiedStdin.recorded.calls[0]!.handle]);
    expect(parentDiedStdin.recorded.grandchildExited).toBe(true);

    // 10. Running portal-pick-image.py directly with /dev/null on stdin does not falsely cancel.
    const devnull = await runWithMockPortal(s, {
      responseCode: 0,
      uris: [pickedUri],
      devnullStdin: true,
      directPythonHelper: true,
    });
    expect(devnull.child.code).toBe(PORTRAIT_PICKER_EXIT.PICKED);
    expect(devnull.child.stdout).toBe(`${portraitFile}\n`);

    // 11. Without ~/Pictures, current_folder falls back to $HOME.
    rmSync(pictures, { recursive: true, force: true });
    const homeFallback = await runWithMockPortal(s, { responseCode: 1, uris: [] });
    expect(homeFallback.child.code).toBe(PORTRAIT_PICKER_EXIT.CANCELLED);
    expect(homeFallback.recorded.calls[0]!.current_folder_bytes).toEqual([...Buffer.from(s.home), 0]);

    // 12. Session bus present, but no org.freedesktop.portal.Desktop service -> exits 2 (unavailable).
    const noPortal = await runWithMockPortal(s, { exposePortal: false });
    expect(noPortal.child.code).toBe(PORTRAIT_PICKER_EXIT.UNAVAILABLE);
    expect(noPortal.child.stdout).toBe("");
    expect(noPortal.child.stderr).toContain("omastoic:");
  } finally {
    s.cleanup();
  }
}, 25000);
