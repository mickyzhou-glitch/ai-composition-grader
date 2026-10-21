import { describe, expect, it } from "vitest";
import { classNames, filterReviewsByClass } from "./classification";

describe("class classification", () => {
  const items = [{ id: 1, className: "六（1）班" }, { id: 2, className: "六（2）班" }, { id: 3 }];
  it("keeps legacy reviews unclassified and filters exact class names", () => {
    expect(filterReviewsByClass(items, null)).toEqual(items);
    expect(filterReviewsByClass(items, "")).toEqual([items[2]]);
    expect(filterReviewsByClass(items, "六（1）班")).toEqual([items[0]]);
    expect(classNames([...items, items[0]])).toEqual(["六（1）班", "六（2）班"]);
  });
});
