import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Omarchy theme foreground on the popup background. The panel mixes the text
// colour over that background; these pairs are the two themes the panel must hold.
const themes = {
  "Tokyo Night": { ink: "#a9b1d6", background: "#1a1b26", accent: "#7aa2f7" },
  "Catppuccin Latte": { ink: "#4c4f69", background: "#eff1f5", accent: "#1e66f5" },
} as const;

const channel = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const linear = (value: number) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = channel(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrast = (hex: string, background: string) => {
  const lighter = Math.max(luminance(hex), luminance(background));
  const darker = Math.min(luminance(hex), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};
const mix = (foreground: string, background: string, alpha: number) => {
  const fg = channel(foreground);
  const bg = channel(background);
  const blended = fg.map((value, index) => Math.round(value * alpha + bg[index] * (1 - alpha)));
  return `#${blended.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

test("small panel text stays at 4.5:1 and placeholders stay fainter", () => {
  const source = readFileSync(join(import.meta.dir, "../ui/Panel.qml"), "utf8");
  const quiet = Number(source.match(/ink\.b, (0\.\d+)\)\n {2}readonly property color hint/)?.[1]);
  const hint = Number(source.match(/readonly property color hint: Qt\.rgba\(ink\.r, ink\.g, ink\.b, (0\.\d+)\)/)?.[1]);
  expect(quiet).toBeGreaterThan(hint);
  expect(hint).toBeGreaterThan(0);
  const chip = Number(source.match(/host\.picked\s*\?\s*Qt\.rgba\(Commons\.Color\.accent\.r, Commons\.Color\.accent\.g, Commons\.Color\.accent\.b, (0\.\d+)\)/)?.[1]);
  expect(chip).toBeGreaterThan(0);
  for (const [name, theme] of Object.entries(themes)) {
    expect(contrast(mix(theme.ink, theme.background, quiet), theme.background), name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mix(theme.ink, theme.background, 1), theme.background), `${name} typed`).toBeGreaterThan(
      contrast(mix(theme.ink, theme.background, hint), theme.background),
    );
    const fill = mix(theme.accent, theme.background, chip);
    expect(contrast(theme.ink, fill), `${name} selected chip`).toBeGreaterThanOrEqual(4.5);
  }
});
