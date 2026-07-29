import { describe, expect, it, vi } from "vitest";

import { D1AnalysisJobs } from "./d1-analysis-jobs";

describe("D1AnalysisJobs", () => {
  it("reuses an already queued job for the same review", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews") ? { id: "review-1", revision: 2, expires_at: null, image_count: 1 } : {
            id: "job-1", review_id: "review-1", status: "queued", progress_stage: "queued", error_code: null, created_at: 1_700_000_000_000, finished_at: null,
          }),
        })),
      })),
    } as unknown as D1Database;

    const result = await new D1AnalysisJobs(database).enqueue("teacher-1", "review-1");

    expect(result.newlyQueued).toBe(false);
    expect(result.job).toMatchObject({ id: "job-1", status: "queued" });
  });
});
