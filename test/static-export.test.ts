import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import createConfig from "../next.config.ts";

describe("static export configuration", () => {
  it("configures a static export with a deterministic output directory", () => {
    const config = createConfig(PHASE_PRODUCTION_BUILD);
    expect(config.output).toBe("export");
    expect(config.distDir).toBe("dist");
    expect(createConfig(PHASE_DEVELOPMENT_SERVER).distDir).toBe(".next");
  });

  it("does not add dynamic Next.js route handlers", () => {
    const appRoot = path.resolve("app");
    const files = readdirSync(appRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /^route\.(?:[cm]?[jt]sx?)$/u.test(entry.name));

    expect(files).toEqual([]);
  });
});
