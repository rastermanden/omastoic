#!/usr/bin/env python3
"""Run the Omarchy validator after dropping export-ignore paths.

OMARCHY_PLUGIN_VALIDATOR is the upstream validate_plugin.py. This wrapper
replaces its file walk. The scan rules stay the upstream ones.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preflight_scan import export_ignore_patterns, is_export_ignored


def load_upstream(path: Path):
    spec = importlib.util.spec_from_file_location("omarchy_validate_plugin", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load validator: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    upstream_path = Path(os.environ.get("OMARCHY_PLUGIN_VALIDATOR", "")).expanduser()
    if not upstream_path.is_file():
        print("OMARCHY_PLUGIN_VALIDATOR must point at validate_plugin.py", file=sys.stderr)
        return 2
    module = load_upstream(upstream_path)
    original = module.iter_files

    def iter_files(root: Path):
        patterns = export_ignore_patterns(root)
        for path in original(root):
            relative = path.relative_to(root).as_posix()
            if is_export_ignored(relative, patterns):
                continue
            yield path

    module.iter_files = iter_files
    return module.main()


if __name__ == "__main__":
    raise SystemExit(main())
