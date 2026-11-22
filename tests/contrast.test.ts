import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Omarchy theme foreground on the popup background. The panel mixes the text
// colour over that background; these pairs are the two themes the panel must hold.
const themes = {
  "Tokyo Night": { ink: "#a9b1d6", background: "#1a1b26", accent: "#7aa2f7", urgent: "#f7768e" },
  "Catppuccin Latte": { ink: "#4c4f69", background: "#eff1f5", accent: "#1e66f5", urgent: "#d20f39" },
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

test("small panel text stays at 4.5:1, dates hold over the selected-row wash, and placeholders stay fainter", () => {
  const source = readFileSync(join(import.meta.dir, "../ui/Panel.qml"), "utf8");
  const alpha = (name: string) => Number(
    source.match(new RegExp(`readonly property color ${name}: Qt\\.rgba\\(ink\\.r, ink\\.g, ink\\.b, (0\\.\\d+)\\)`))?.[1],
  );
  const quiet = alpha("quiet");
  const dates = alpha("dates");
  const hint = alpha("hint");
  const chip = Number(source.match(/host\.picked\s*\?\s*Qt\.rgba\(Commons\.Color\.accent\.r, Commons\.Color\.accent\.g, Commons\.Color\.accent\.b, (0\.\d+)\)/)?.[1]);
  const urgentChip = Number(source.match(/host\.destructive\s*\?\s*Qt\.rgba\(Commons\.Color\.urgent\.r, Commons\.Color\.urgent\.g, Commons\.Color\.urgent\.b, (0\.\d+)\)/)?.[1]);
  const wash = Number(source.match(/if \(on\) return Qt\.rgba\(Commons\.Color\.accent\.r, Commons\.Color\.accent\.g, Commons\.Color\.accent\.b, (0\.\d+)\)/)?.[1]);

  // Dates sit over the tint, so they read stronger than the other quiet text
  // but still quieter than the author's name. Placeholders stay the faintest.
  expect(hint).toBeGreaterThan(0);
  expect(quiet).toBeGreaterThan(hint);
  expect(dates).toBeGreaterThan(quiet);
  expect(dates).toBeLessThan(1);
  expect(chip).toBeGreaterThan(0);
  expect(urgentChip).toBeGreaterThan(0);
  expect(wash).toBeGreaterThan(0);

  for (const [name, theme] of Object.entries(themes)) {
    expect(contrast(mix(theme.ink, theme.background, quiet), theme.background), name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mix(theme.ink, theme.background, 1), theme.background), `${name} typed`).toBeGreaterThan(
      contrast(mix(theme.ink, theme.background, hint), theme.background),
    );
    const fill = mix(theme.accent, theme.background, chip);
    expect(contrast(theme.ink, fill), `${name} selected chip`).toBeGreaterThanOrEqual(4.5);
    const urgentFill = mix(theme.urgent, theme.background, urgentChip);
    expect(contrast(theme.ink, urgentFill), `${name} destructive confirm button`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.urgent, theme.background), `${name} urgent border and error text`).toBeGreaterThanOrEqual(4.5);
    // A selected row paints the accent wash behind the dates, so the date
    // colour is mixed over the wash, not over the plain popup background.
    const washColor = mix(theme.accent, theme.background, wash);
    expect(contrast(mix(theme.ink, washColor, dates), washColor), `${name} selected-row dates`).toBeGreaterThanOrEqual(4.5);
  }
});
