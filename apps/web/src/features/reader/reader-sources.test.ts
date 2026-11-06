/** Guard: effects in the reader must not return the value of an expression body (e.g. `useEffect(() => window.scrollTo(0, 0))`).
 * Newer Chrome returns a Promise from scrollTo; React then calls it as the cleanup and the page crashes on navigation. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL(".", import.meta.url));

describe("reader effects", () => {
  it("use block bodies (no implicit cleanup return values)", () => {
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) =>
        readFileSync(dir + f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => /use(Layout)?Effect\(\s*\(\)\s*=>\s*[^{\s]/.test(line)),
      )
      .map(({ f, i, line }) => `${f}:${i} ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
