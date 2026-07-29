import { describe, expect, it } from "vitest";

import { summarizeMigrationAudit } from "./migration-audit";

describe("migration audit", () => {
  it("reports database counts and missing registered files without exposing their paths", () => {
    expect(summarizeMigrationAudit([["users", 3], ["reviews", 30]], [true, false, true]))
      .toEqual({ tables: { users: 3, reviews: 30 }, files: { registered: 3, present: 2, missing: 1 } });
  });
});
