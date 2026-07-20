import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "review-1" }) }));

import ReviewPage from "./page";

const review = {
  id: "review-1",
  status: "ready_for_review",
  revision: 1,
  config: { title: "为自己鼓掌", templateType: "custom" },
  images: [{ id: 1, position: 0, annotationPath: "images/a.jpg", originalName: "作文.jpg" }],
  annotations: [],
  report: {
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真诚",
    painPoints: ["结尾快"], commonIssues: ["句式单一"], revisionSuggestions: ["补感受"],
    scores: { themeIntent: 8, contentSelection: 8, structure: 7, languageExpression: 7, writingConventions: 3, total: 33, level: "二类作文" },
    sampleParagraphs: ["示范段"],
  },
};

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { headers: { "content-type": "application/json" } }));
}

describe("复核页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("保存时 PATCH 完整 report 与 annotations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json(review));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "观察细致，继续保持");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/reviews/review-1");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toMatchObject({
      report: { personalizedComment: "观察细致，继续保持" }, annotations: [],
    });
  });
});
