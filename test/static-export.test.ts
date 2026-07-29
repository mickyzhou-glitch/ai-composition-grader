import { describe, expect, it } from "vitest";

import config from "../next.config.ts";

describe("static export configuration", () => {
  it("configures a static export with a deterministic output directory", () => {
    expect(config.output).toBe("export");
    expect(config.distDir).toBe("dist");
  });
});
