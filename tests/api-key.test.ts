import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./sandbox.ts";

const keyName = "TYPESAFE_API_KEY";

function assignedKey(line: string): boolean {
  return new RegExp(`${keyName}\\s*[=:]`).test(line);
}

test("a TypeSafe key assignment is a secret", () => {
  expect(assignedKey([keyName, "=", "example-value"].join(""))).toBe(true);
  expect(assignedKey([keyName, ": ${{ secrets.", keyName, " }}"].join(""))).toBe(true);
  expect(assignedKey(`say that their \`${keyName}\` will be used`)).toBe(false);
});

test("no tracked file assigns an API key", () => {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const hits: string[] = [];
  for (const file of listed) {
    const text = readFileSync(join(root, file), "utf8");
    text.split("\n").forEach((line, index) => {
      if (assignedKey(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  expect(hits).toEqual([]);
});

test("CI does not name the TypeSafe key", () => {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ".github"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const hits = listed.filter((file) => readFileSync(join(root, file), "utf8").includes(keyName));
  expect(hits).toEqual([]);
});
