import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import NewReviewPage from "./page";

async function confirmPrivacy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("确认真实作文上传说明"));
}

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("新建作文批改", () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("支持内置题目与自定义字段验证", async () => {
    const user = userEvent.setup();
    render(<NewReviewPage />);

    expect(screen.getByRole("button", { name: /为自己鼓掌/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    expect(screen.getByRole("button", { name: "自定义题目" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请填写作文题目");
    expect(screen.getByLabelText("目标字数")).toHaveValue(600);
  });

  it("自定义题目可用 AI 先生成写作、结构与评分要求，且保留可编辑性", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([])).mockImplementationOnce(() => json({
      writingRequirements: "选择一件真实小事，写清变化。",
      structureRequirements: "开头设置情境，中间展开经过，结尾回扣题目。",
      scoringFocus: "事件具体，细节真实，感受自然。",
    }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("作文题目"), "我学会了等待");
    await user.click(screen.getByRole("button", { name: "AI 生成要求" }));

    expect(await screen.findByDisplayValue("选择一件真实小事，写清变化。")).toBeInTheDocument();
    expect(screen.getByDisplayValue("开头设置情境，中间展开经过，结尾回扣题目。")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("写作要求"));
    await user.type(screen.getByLabelText("写作要求"), "教师手动调整后的要求。");
    expect(screen.getByDisplayValue("教师手动调整后的要求。")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/assignment-guidance", expect.objectContaining({ method: "POST" }));
  });

  it("上传课本后可不填题目直接导入，图片不混入作文上传", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) => url === "/api/assignment-guidance" ? json({
      title: "我的拿手好戏", targetCharacters: 500,
      writingRequirements: "把拿手好戏写具体。", structureRequirements: "重点部分详写。", scoringFocus: "详略得当。",
    }) : json([]));
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    expect(screen.getByRole("button", { name: "AI 生成要求" })).toBeDisabled();
    const upload = screen.getByLabelText("选择课本图片");
    await user.upload(upload, new File(["book"], "课本.png", { type: "image/png" }));
    await user.upload(upload, new File(["second"], "第二页.jpg", { type: "image/jpeg" }));
    expect(screen.getAllByRole("img", { name: /课本第/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "移除课本图片 第二页.jpg" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:第二页.jpg");
    await user.click(screen.getByRole("button", { name: "AI 生成要求" }));
    expect(await screen.findByDisplayValue("我的拿手好戏")).toBeInTheDocument();
    expect(screen.getByLabelText("目标字数")).toHaveValue(500);
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/assignment-guidance");
    expect(JSON.parse(request?.[1]?.body as string)).toMatchObject({
      title: "", textbookImages: ["data:image/png;base64,Ym9vaw=="],
    });
    await user.clear(screen.getByLabelText("写作要求"));
    await user.type(screen.getByLabelText("写作要求"), "教师调整后的要求");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    expect(screen.getByText("0/4 张")).toBeInTheDocument();
  });

  it("课本图片超出数量或大小时保留已选图片，识别失败保留已填要求并可重试", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => url === "/api/assignment-guidance"
      ? json({ code: "AI_REQUEST_FAILED", message: "课本识别失败" }, 502) : json([]));
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("写作要求"), "保留教师要求");
    const upload = screen.getByLabelText("选择课本图片");
    await user.upload(upload, new File(["x"], "原图.jpg", { type: "image/jpeg" }));
    await user.upload(upload, Array.from({ length: 4 }, (_, i) => new File(["x"], `${i}.png`, { type: "image/png" })));
    expect(screen.getByRole("alert")).toHaveTextContent("最多上传 4 张课本图片");
    const large = new File(["x"], "大图.png", { type: "image/png" });
    Object.defineProperty(large, "size", { value: 21 * 1024 * 1024 });
    await user.upload(upload, large);
    expect(screen.getByRole("alert")).toHaveTextContent("20MB");
    expect(screen.getAllByRole("img", { name: /课本第/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "AI 生成要求" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("课本识别失败");
    expect(screen.getByLabelText("写作要求")).toHaveValue("保留教师要求");
    expect(screen.getByRole("button", { name: "AI 生成要求" })).toBeEnabled();
    expect(screen.getAllByRole("img", { name: /课本第/ })).toHaveLength(1);
  });

  it("生成期间修改题目时不覆盖新的题目和教师要求", async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => url === "/api/assignment-guidance"
      ? new Promise<Response>((resolve) => { finish = resolve; }) : json([]));
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("作文题目"), "旧题目");
    await user.click(screen.getByRole("button", { name: "AI 生成要求" }));
    await user.clear(screen.getByLabelText("作文题目"));
    await user.type(screen.getByLabelText("作文题目"), "新题目");
    await user.type(screen.getByLabelText("写作要求"), "新的教师要求");
    finish(await json({ writingRequirements: "旧要求", structureRequirements: "旧结构", scoringFocus: "旧评分" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "AI 生成要求" })).toBeEnabled());
    expect(screen.getByLabelText("作文题目")).toHaveValue("新题目");
    expect(screen.getByLabelText("写作要求")).toHaveValue("新的教师要求");
    expect(screen.getByRole("alert")).toHaveTextContent("已修改");
  });

  it("在提交前必须确认真实作文上传说明", async () => {
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "composition.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));

    expect(screen.getByText(/请勿在图片或文档中保留学生姓名、学号、班级、学校/)).toBeInTheDocument();
    expect(screen.getByText(/长期保留/)).toBeInTheDocument();
    expect(screen.queryByText(/30 天|到期|自动永久删除/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并开始批改" })).toBeDisabled();
    await confirmPrivacy(user);
    expect(screen.getByRole("button", { name: "创建并开始批改" })).toBeEnabled();
  });

  it("填写学生姓名后按调整后的四图顺序上传，保留旋转且不提供裁剪", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-new", revision: 0 }, 201))
      .mockImplementationOnce(() =>
        json({ images: [
          { id: 11, position: 0 },
          { id: 12, position: 1 },
          { id: 13, position: 2 },
          { id: 14, position: 3 },
        ], revision: 1 }),
      )
      .mockImplementationOnce(() => json({ id: "job-new", status: "queued", progressStage: "queued" }, 202));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.type(screen.getByLabelText("学生姓名"), "李羿辰");
    const files = ["一.jpg", "二.jpg", "三.jpg", "四.jpg"].map(
      (name) => new File([name], name, { type: "image/jpeg" }),
    );
    await user.upload(screen.getByLabelText("选择作文图片"), files);
    expect(screen.getByText("4/4 张")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上移 三.jpg" }));
    await user.click(screen.getByRole("button", { name: "旋转 二.jpg" }));
    expect(screen.queryByRole("group", { name: /裁剪/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /裁剪/ })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "二.jpg 预览" })).toHaveStyle({ transform: "rotate(90deg)" });
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    const summary = screen.getByLabelText("图片提交顺序");
    expect(within(summary).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("一.jpg"),
      expect.stringContaining("三.jpg"),
      expect.stringContaining("二.jpg"),
      expect.stringContaining("四.jpg"),
    ]);
    expect(screen.getByText("李羿辰")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-new"));
    const reviewRequest = fetchMock.mock.calls[1];
    expect(reviewRequest[0]).toBe("/api/reviews");
    expect(JSON.parse((reviewRequest[1] as RequestInit).body as string)).toMatchObject({
      studentName: "李羿辰",
      config: { title: "为自己鼓掌", sampleParagraphCount: 5 },
    });
    const uploaded = (fetchMock.mock.calls[2][1] as RequestInit).body as FormData;
    expect(uploaded.get("expectedRevision")).toBe("0");
    expect(uploaded.get("privacyConfirmed")).toBe("true");
    expect(uploaded.get("privacyNoticeVersion")).toBe("2026-07-22");
    expect(uploaded.getAll("images").map((file) => (file as File).name)).toEqual([
      "一.jpg",
      "三.jpg",
      "二.jpg",
      "四.jpg",
    ]);
    expect(JSON.parse(String(uploaded.get("imageMeta")))).toHaveLength(4);
  });

  it("上传失败后改题重试会先 PATCH 最新配置，再上传图片", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-retry", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ code: "UPLOAD_FAILED", message: "上传失败" }, 502))
      .mockImplementationOnce(() => json({ id: "review-retry", revision: 1 }))
      .mockImplementationOnce(() => json({ images: [{ id: 31, position: 0 }], revision: 2 }))
      .mockImplementationOnce(() => json({ id: "job-retry", status: "queued", progressStage: "queued" }, 202));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("作文题目"), "第一次题目");
    await user.type(screen.getByLabelText("写作要求"), "写一件具体的事。");
    await user.type(screen.getByLabelText("结构要求"), "开头点题，结尾升华。");
    await user.type(screen.getByLabelText("评分侧重"), "细节描写。");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "first.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上传失败");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/analyze"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.clear(screen.getByLabelText("作文题目"));
    await user.type(screen.getByLabelText("作文题目"), "修订后的题目");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/reviews/review-retry",
      expect.objectContaining({ method: "PATCH" }),
    ));
    const configRequest = fetchMock.mock.calls.find(([url, init]) =>
      url === "/api/reviews/review-retry" && (init as RequestInit).method === "PATCH",
    );
    expect(JSON.parse((configRequest?.[1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 0,
      config: { title: "修订后的题目" },
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-retry"));
  });

  it("上传成功后自动提交完整分析，提交成功才进入批改详情", async () => {
    let finishAnalysis!: (response: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-versioned", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ images: [{ id: 41, position: 0 }], revision: 1 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishAnalysis = resolve; }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "versioned.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/reviews/review-versioned/analyze",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "full" }) }),
    ));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在启动 AI 分析…" })).toBeDisabled();
    finishAnalysis(await json({ id: "job-versioned", status: "queued", progressStage: "queued" }, 202));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-versioned"));
  });

  it("启动分析失败后重试只提交分析，不重复创建、保存或上传作文", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-analysis-retry", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ images: [{ id: 51, position: 0 }], revision: 1 }))
      .mockImplementationOnce(() => json({ code: "UNAVAILABLE", message: "暂时无法启动分析" }, 503))
      .mockImplementationOnce(() => json({ id: "job-retry", status: "queued", progressStage: "queued" }, 202));
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(screen.getByLabelText("选择作文图片"), new File(["image"], "retry.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("作文已保存");
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-analysis-retry"));
    expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/reviews", "POST"],
      ["/api/reviews/review-analysis-retry/images", "POST"],
      ["/api/reviews/review-analysis-retry/analyze", "POST"],
      ["/api/reviews/review-analysis-retry/analyze", "POST"],
    ]);
  });

  it("分析启动失败后修改学生信息会保存最新信息，复用已转换图片再启动分析", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-edit-retry", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ images: [{ id: 61, position: 0 }], revision: 1 }))
      .mockImplementationOnce(() => json({ code: "UNAVAILABLE", message: "暂时无法启动分析" }, 503))
      .mockImplementationOnce(() => json({ id: "review-edit-retry", revision: 2 }))
      .mockImplementationOnce(() => json({ id: "job-retry", status: "queued", progressStage: "queued" }, 202));
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(screen.getByLabelText("选择作文图片"), new File(["image"], "edit.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "旋转 edit.jpg" }));
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.type(screen.getByLabelText("学生姓名"), "小明");
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-edit-retry"));
    const changes = fetchMock.mock.calls.slice(4);
    expect(changes.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/reviews/review-edit-retry", "PATCH"], ["/api/reviews/review-edit-retry/analyze", "POST"],
    ]);
    expect(JSON.parse(changes[0][1]?.body as string)).toMatchObject({ expectedRevision: 1, studentName: "小明" });
  });

  it("提供后置相机入口，并将连续拍摄的页面追加到图片列表", async () => {
    render(<NewReviewPage />);

    await userEvent.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await userEvent.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    const camera = screen.getByLabelText("使用手机相机拍照");
    expect(camera).toHaveAttribute("capture", "environment");
    await userEvent.upload(camera, new File(["camera"], "camera.jpg", { type: "image/jpeg" }));

    expect(screen.getByText("1/4 张")).toBeInTheDocument();
    expect(screen.getByText("第 1 页 · camera.jpg")).toBeInTheDocument();
  });

  it("复用本账号班级并将班级随作文提交", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (url === "/api/classes") return json(["六（1）班"]);
      if (url === "/api/saved-assignments") return json([]);
      if (url === "/api/reviews" && options?.method === "POST") return json({ id: "class-review", revision: 0 }, 201);
      if (url === "/api/reviews/class-review/analyze") return json({ id: "job-class", status: "queued", progressStage: "queued" }, 202);
      return json({ images: [{ id: 1, position: 0 }], revision: 1 });
    });
    const user = userEvent.setup();
    render(<NewReviewPage />);
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.type(screen.getByLabelText("班级", { exact: true }), "六（1）班");
    await user.upload(screen.getByLabelText("选择作文图片"), new File(["x"], "作文.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=class-review"));
    const creation = fetchMock.mock.calls.find(([url, options]) => url === "/api/reviews" && options?.method === "POST");
    expect(JSON.parse(creation?.[1]?.body as string)).toMatchObject({ className: "六（1）班" });
  });
});
