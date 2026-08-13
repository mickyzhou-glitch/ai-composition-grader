import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

import config from "../next.config.ts";

describe("static export configuration", () => {
  it("configures a static export with a deterministic output directory", () => {
    expect(config.output).toBe("export");
    expect(config.distDir).toBe("dist");
  });

  it("does not add dynamic Next.js route handlers", () => {
    const appRoot = path.resolve("app");
    const files = readdirSync(appRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /^route\.(?:ts|tsx|js|jsx)$/u.test(entry.name));

    expect(files).toEqual([]);
  });
});
