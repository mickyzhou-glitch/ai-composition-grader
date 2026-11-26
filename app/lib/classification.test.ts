import { describe, expect, it } from "vitest";
import { classNames, filterReviewsByClass, filterReviewsByTitle, titleNames } from "./classification";

describe("class & title classification", () => {
  const items = [
    { id: 1, className: "六（1）班", config: { title: "为自己鼓掌" } },
    { id: 2, className: "六（2）班", config: { title: "春游" } },
    { id: 3, config: { title: "为自己鼓掌" } },
  ];
  it("keeps legacy reviews unclassified and filters exact class and title names", () => {
    expect(filterReviewsByClass(items, null)).toEqual(items);
    expect(filterReviewsByClass(items, "")).toEqual([items[2]]);
    expect(filterReviewsByClass(items, "六（1）班")).toEqual([items[0]]);
    expect(classNames([...items, items[0]], ["六（3）班"])).toEqual(["六（1）班", "六（2）班", "六（3）班"]);
    expect(titleNames(items)).toEqual(["为自己鼓掌", "春游"]);
    expect(filterReviewsByTitle(items, null)).toEqual(items);
    expect(filterReviewsByTitle(items, "春游")).toEqual([items[1]]);
  });
});
