import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import SettingsPage from "./page";

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("设置页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只显示密钥已配置状态，不回显密钥", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      response({
        ok: true,
        data: {
          vision: { baseUrl: "https://vision.example.com/v1", model: "vision-model", keyConfigured: true },
          content: { baseUrl: "https://content.example.com/v1", model: "writer-model", keyConfigured: true },
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByRole("heading", { name: "拍照识图模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "作文内容模型" })).toBeInTheDocument();
    expect(screen.getByLabelText("拍照识图模型名称")).toHaveValue("vision-model");
    expect(screen.getByLabelText("作文内容模型名称")).toHaveValue("writer-model");
    expect(screen.getByLabelText("拍照识图 API Key")).toHaveValue("");
    expect(screen.getByLabelText("作文内容 API Key")).toHaveValue("");
    expect(screen.getAllByText("密钥已配置，留空将继续使用原密钥")).toHaveLength(2);
  });

  it("测试连接失败时展示服务端错误", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        response({
          ok: true,
          data: {
            vision: { baseUrl: "https://vision.example.com/v1", model: "vision", keyConfigured: false },
            content: { baseUrl: "https://content.example.com/v1", model: "grader", keyConfigured: false },
          },
        }),
      )
      .mockImplementationOnce(() =>
        response({ ok: false, error: { code: "CONNECTION_FAILED", message: "无法连接模型" } }, 502),
      );
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByDisplayValue("grader");
    await user.type(screen.getByLabelText("作文内容 API Key"), "secret");
    await user.click(screen.getByRole("button", { name: "测试作文内容模型" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接模型");
  });

  it("保存内容模型时只发送 content 角色设置", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ ok: true, data: {
        vision: { baseUrl: "https://vision.example.com/v1", model: "vision", keyConfigured: true },
        content: { baseUrl: "https://content.example.com/v1", model: "writer", keyConfigured: true },
      } }))
      .mockImplementationOnce(() => response({ ok: true, data: {
        baseUrl: "https://content.example.com/v1", model: "writer-2", keyConfigured: true,
      } }));
    const user = userEvent.setup();
    render(<SettingsPage />);

    const model = await screen.findByLabelText("作文内容模型名称");
    await user.clear(model);
    await user.type(model, "writer-2");
    await user.click(screen.getByRole("button", { name: "保存作文内容模型" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/settings/content");
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      baseUrl: "https://content.example.com/v1",
      model: "writer-2",
    });
  });

  it("请求无响应时结束测试并恢复按钮，允许重新测试", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ ok: true, data: {
        content: { baseUrl: "https://content.example/v1", model: "gemini", keyConfigured: true },
      } }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }))
      .mockImplementationOnce(() => response({ ok: true, data: { connected: true } }));
    render(<SettingsPage />);
    await screen.findByDisplayValue("gemini");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "测试作文内容模型" }));
      expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();
      expect(fetchMock.mock.calls[1][1]?.signal).toBeDefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
      expect(screen.getByRole("alert")).toHaveTextContent("超时");
      expect(screen.getByRole("button", { name: "测试作文内容模型" })).toBeEnabled();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "测试作文内容模型" })); });
      expect(screen.getByRole("status")).toHaveTextContent("作文内容模型连接成功");
    } finally {
      vi.useRealTimers();
    }
  });
});
