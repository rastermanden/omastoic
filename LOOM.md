# Loom agent notes for omastoic

omastoic is an Omarchy 4 (Quattro) shell plugin. Before you design, build, test, debug, release or publish it, read the matching skill, vendored from [build-omarchy-plugins](https://github.com/tcballard/build-omarchy-plugins) at `edc72aa`:

`.agents/skills/<name>/SKILL.md`

Follow any `references/` files the skill links to. See `.agents/skills/README.md` for attribution and updating.

| Skill | Use when |
|---|---|
| omarchy-plugin-design | Planning architecture, plugin kinds, dependencies, state, IPC |
| omarchy-plugin-scaffold | Adding new entry points, manifest, QML, tests, CI |
| omarchy-bar-widget | Bar widget settings, orientation, popouts, instances |
| omarchy-panel-overlay | Panels, overlays, menus: summon/hide, focus, dismissal |
| omarchy-service-ipc | Process-wide QML services and IPC contracts |
| omarchy-qml-patterns | Theme tokens, layout, process execution, local state |
| omarchy-plugin-test | Validating changes (manifest, QML, fixtures, live shell) |
| omarchy-plugin-debug | Plugin not discovered, validated, loaded or summoned |
| omarchy-plugin-demo | Deterministic demo and marketplace screenshot |
| omarchy-plugin-migrate | Moving old installer-style or Quickshell setups to Quattro |
| omarchy-plugin-release | Release preflight: versions, tags, CI, install/update |
| omarchy-plugin-publish | Marketplace submission and review responses |
