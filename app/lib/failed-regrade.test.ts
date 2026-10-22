import { describe, expect, it } from "vitest";

import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

import { chunkItems } from "./failed-regrade";

describe("chunkItems", () => {
  it("按批量上限把失败作文拆成连续批次", () => {
    const ids = Array.from({ length: BATCH_REANALYSIS_LIMIT + 1 }, (_, index) => `review-${index}`);
    const chunks = chunkItems(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(BATCH_REANALYSIS_LIMIT);
    expect(chunks[1]).toEqual([`review-${BATCH_REANALYSIS_LIMIT}`]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("空列表不产生批次", () => {
    expect(chunkItems([])).toEqual([]);
  });
});
