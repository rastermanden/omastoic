#!/usr/bin/env python3
"""Open the desktop file chooser for a JPEG or PNG portrait over D-Bus.

Uses org.freedesktop.portal.FileChooser.OpenFile on one session-bus connection
so the portal's directed Response signal reaches this process.

Exit codes:
  0: a local file was chosen (printed to stdout with a trailing newline)
  1: the user cancelled or picked nothing
  2: the desktop portal could not be reached or ended unexpectedly
  3: the user chose a remote or unsupported file path
"""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import socket
import stat
import sys

sys.dont_write_bytecode = True

ANSWER_TIMEOUT_SEC = 600
OPEN_FILE_TIMEOUT_MS = 10_000
CLOSE_TIMEOUT_MS = 1_000
EXIT_PICKED = 0
EXIT_CANCELLED = 1
EXIT_UNAVAILABLE = 2
EXIT_UNSUPPORTED = 3

FILTER_LABEL = "JPEG and PNG images"
FILTER_RULES = [
    (1, "image/jpeg"),
    (1, "image/png"),
    (0, "*.jpg"),
    (0, "*.jpeg"),
    (0, "*.png"),
    (0, "*.JPG"),
    (0, "*.JPEG"),
    (0, "*.PNG"),
]


def load_gio():
    try:
        import gi

        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib

        try:
            gi.require_version("GLibUnix", "2.0")
            from gi.repository import GLibUnix
        except (ImportError, ValueError):
            GLibUnix = None

        return Gio, GLib, GLibUnix
    except (ImportError, ValueError) as exc:
        print(f"portal picker unavailable: {exc}", file=sys.stderr)
        return None


def is_local_hostname(hostname: str | None) -> bool:
    if not hostname:
        return True
    lower = hostname.lower()
    return lower == "localhost" or lower == socket.gethostname().lower()


def stdin_is_parent_pipe() -> bool:
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return False
        mode = os.fstat(0).st_mode
        return stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)
    except (OSError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--title", default="Choose portrait image")
    parser.add_argument("--folder", default="")
    args, unknown = parser.parse_known_args()
    if unknown:
        print(f"unknown option: {unknown[0]}", file=sys.stderr)
        return EXIT_UNAVAILABLE

    loaded = load_gio()
    if loaded is None:
        return EXIT_UNAVAILABLE
    Gio, GLib, GLibUnix = loaded

    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as exc:
        print(f"could not connect to session bus: {exc.message}", file=sys.stderr)
        return EXIT_UNAVAILABLE

    unique_name = bus.get_unique_name()
    if not isinstance(unique_name, str) or not unique_name.startswith(":"):
        print("could not determine session bus name", file=sys.stderr)
        return EXIT_UNAVAILABLE

    loop = GLib.MainLoop()
    outcome: dict[str, object] = {"status": "pending", "uris": []}
    active_handle: list[str] = []
    closed_sent = False

    def on_response(_connection, _sender, _path, _interface, _signal, params):
        try:
            code, results = params.unpack()
        except Exception as exc:
            outcome["status"] = "unavailable"
            outcome["reason"] = f"malformed portal response: {exc}"
            loop.quit()
            return
        if code == 0:
            raw_uris = results.get("uris", []) if isinstance(results, dict) else []
            outcome["status"] = "picked"
            outcome["uris"] = list(raw_uris) if isinstance(raw_uris, (list, tuple)) else []
        elif code == 1:
            outcome["status"] = "cancelled"
        else:
            outcome["status"] = "unavailable"
            outcome["reason"] = "portal file chooser ended unexpectedly"
        loop.quit()

    def subscribe(path: str) -> None:
        bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Request",
            "Response",
            path,
            None,
            Gio.DBusSignalFlags.NONE,
            on_response,
        )

    token = f"omastoic_{os.getpid()}_{secrets.token_hex(6)}"
    sender = unique_name.lstrip(":").replace(".", "_")
    predicted = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    subscribe(predicted)

    filter_entry = (FILTER_LABEL, FILTER_RULES)
    options: dict[str, object] = {
        "handle_token": GLib.Variant("s", token),
        "multiple": GLib.Variant("b", False),
        "filters": GLib.Variant("a(sa(us))", [filter_entry]),
        "current_filter": GLib.Variant("(sa(us))", filter_entry),
    }

    if args.folder:
        folder_bytes = os.fsencode(args.folder)
        if b"\x00" not in folder_bytes:
            options["current_folder"] = GLib.Variant.new_bytestring(folder_bytes)

    try:
        reply = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.FileChooser",
            "OpenFile",
            GLib.Variant("(ssa{sv})", ("", args.title, options)),
            None,
            Gio.DBusCallFlags.NONE,
            OPEN_FILE_TIMEOUT_MS,
            None,
        ).unpack()
    except GLib.Error as exc:
        print(f"portal file chooser failed: {exc.message}", file=sys.stderr)
        return EXIT_UNAVAILABLE

    if not reply or not isinstance(reply[0], str) or not reply[0]:
        print("portal file chooser returned no request handle", file=sys.stderr)
        return EXIT_UNAVAILABLE
    handle = reply[0]

    active_handle.append(handle)
    if handle != predicted:
        subscribe(handle)

    def cancel_and_close() -> bool:
        nonlocal closed_sent
        if outcome["status"] == "pending":
            outcome["status"] = "cancelled"
        if active_handle and not closed_sent:
            closed_sent = True
            try:
                bus.call_sync(
                    "org.freedesktop.portal.Desktop",
                    active_handle[0],
                    "org.freedesktop.portal.Request",
                    "Close",
                    None,
                    None,
                    Gio.DBusCallFlags.NONE,
                    CLOSE_TIMEOUT_MS,
                    None,
                )
            except GLib.Error:
                pass
        loop.quit()
        return GLib.SOURCE_REMOVE

    def on_stdin_event(_fd_or_ch, condition) -> bool:
        if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
            return cancel_and_close()
        if condition & GLib.IOCondition.IN:
            try:
                chunk = os.read(0, 1)
            except OSError:
                return cancel_and_close()
            if not chunk:
                return cancel_and_close()
        return GLib.SOURCE_CONTINUE

    if GLibUnix is not None:
        GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, cancel_and_close)
        GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, cancel_and_close)
    else:
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, cancel_and_close)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, cancel_and_close)

    if stdin_is_parent_pipe():
        watch_cond = GLib.IOCondition.HUP | GLib.IOCondition.ERR | GLib.IOCondition.IN
        if GLibUnix is not None and hasattr(GLibUnix, "fd_add_full"):
            GLibUnix.fd_add_full(GLib.PRIORITY_DEFAULT, 0, watch_cond, on_stdin_event)
        else:
            GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT, watch_cond, on_stdin_event)

    GLib.timeout_add_seconds(ANSWER_TIMEOUT_SEC, cancel_and_close)
    loop.run()

    if outcome["status"] == "unavailable":
        print(str(outcome.get("reason") or "portal file chooser ended unexpectedly"), file=sys.stderr)
        return EXIT_UNAVAILABLE

    if outcome["status"] != "picked":
        return EXIT_CANCELLED

    uris = outcome["uris"]
    if not isinstance(uris, list) or not uris:
        return EXIT_CANCELLED

    first_uri = uris[0]
    if not isinstance(first_uri, str):
        print("selected file is not a local path", file=sys.stderr)
        return EXIT_UNSUPPORTED

    try:
        path, hostname = GLib.filename_from_uri(first_uri)
    except (GLib.Error, TypeError, ValueError, UnicodeError) as exc:
        print(f"selected file is not a local path: {exc}", file=sys.stderr)
        return EXIT_UNSUPPORTED

    if not is_local_hostname(hostname):
        print("selected file is not a local path", file=sys.stderr)
        return EXIT_UNSUPPORTED

    if not path or "\n" in path or "\r" in path or "\x00" in path:
        print("selected file path is not supported", file=sys.stderr)
        return EXIT_UNSUPPORTED

    sys.stdout.write(f"{path}\n")
    sys.stdout.flush()
    return EXIT_PICKED


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"portal picker failed: {exc}", file=sys.stderr)
        sys.exit(EXIT_UNAVAILABLE)
