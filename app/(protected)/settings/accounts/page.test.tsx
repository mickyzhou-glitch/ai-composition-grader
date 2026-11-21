import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../../../../src/auth/password-proof-browser", () => ({
  deriveBrowserPasswordVerifier: vi.fn(async () => new Uint8Array(32).fill(11)),
}));

import AdminAccountsPage from "./page";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const sampleOverview = {
  currentUserId: "admin-1",
  generatedAt: "2026-11-21T04:00:00.000Z",
  summary: {
    totalUsers: 2,
    enabledUsers: 2,
    disabledUsers: 0,
    adminCount: 1,
    teacherCount: 1,
    onlineUsers: 1,
    activeSessionsTotal: 2,
    activeUsers7d: 2,
    totalReviews: 18,
    reviews7d: 6,
    totalJobsSucceeded: 19,
    totalJobsFailed: 1,
    loginsSucceeded7d: 9,
    loginsFailed7d: 8,
    rateLimitedUsers: 1,
  },
  accounts: [
    {
      id: "admin-1",
      username: "micky",
      role: "admin",
      isCurrentUser: true,
      enabled: true,
      disabledAt: null,
      mustChangePassword: false,
      proofMode: "modern",
      rateLimited: false,
      consecutiveFailures15m: 0,
      activityLevel: "online",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-21T04:00:00.000Z",
      login: {
        activeSessions: 1,
        lastSeenAt: "2026-11-21T03:59:00.000Z",
        lastLoginAt: "2026-11-21T01:00:00.000Z",
        succeeded7d: 5,
        failed7d: 0,
        lastFailedAt: null,
      },
      usage: {
        totalReviews: 4,
        reviews7d: 2,
        reviews30d: 4,
        draftCount: 0,
        analyzingCount: 0,
        pendingReviewCount: 1,
        reviewedCount: 1,
        exportedCount: 2,
        failedCount: 0,
        rejectedCount: 0,
        jobsSucceeded: 4,
        jobsFailed: 0,
        jobsActive: 0,
        savedAssignmentsCount: 2,
        standingRulesCount: 3,
        essayOpinionsCount: 1,
        lastReviewActivityAt: "2026-11-21T03:50:00.000Z",
        lastActiveAt: "2026-11-21T03:59:00.000Z",
      },
      recentEvents: [
        {
          id: 1,
          userId: "admin-1",
          username: "micky",
          eventType: "login_succeeded",
          metadata: { mode: "proof" },
          createdAt: "2026-11-21T01:00:00.000Z",
        },
      ],
    },
    {
      id: "teacher-1",
      username: "teacher_wang",
      role: "teacher",
      isCurrentUser: false,
      enabled: true,
      disabledAt: null,
      mustChangePassword: true,
      proofMode: "modern",
      rateLimited: true,
      consecutiveFailures15m: 8,
      activityLevel: "active_7d",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-11-20T08:00:00.000Z",
      login: {
        activeSessions: 1,
        lastSeenAt: "2026-11-20T08:00:00.000Z",
        lastLoginAt: "2026-11-20T07:30:00.000Z",
        succeeded7d: 4,
        failed7d: 8,
        lastFailedAt: "2026-11-21T03:55:00.000Z",
      },
      usage: {
        totalReviews: 14,
        reviews7d: 4,
        reviews30d: 14,
        draftCount: 0,
        analyzingCount: 0,
        pendingReviewCount: 2,
        reviewedCount: 5,
        exportedCount: 7,
        failedCount: 0,
        rejectedCount: 0,
        jobsSucceeded: 15,
        jobsFailed: 1,
        jobsActive: 0,
        savedAssignmentsCount: 1,
        standingRulesCount: 4,
        essayOpinionsCount: 2,
        lastReviewActivityAt: "2026-11-20T07:55:00.000Z",
        lastActiveAt: "2026-11-20T08:00:00.000Z",
      },
      recentEvents: [],
    },
  ],
  recentEvents: [
    {
      id: 1,
      userId: "admin-1",
      username: "micky",
      eventType: "login_succeeded",
      metadata: { mode: "proof" },
      createdAt: "2026-11-21T01:00:00.000Z",
    },
  ],
};

describe("管理员账号与活跃监控页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("展示账号概览指标、登录与批改活跃数据，并保护自身管理员账号不被误停用", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse({ ok: true, data: sampleOverview }),
    );

    render(<AdminAccountsPage />);

    expect(await screen.findByRole("heading", { name: "账号与活跃监控" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "micky" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "teacher_wang" })).toBeInTheDocument();
    expect(screen.getByText("共 14 篇")).toBeInTheDocument();
    expect(screen.getByText("登录锁定（连错 8 次）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除登录锁定" })).toBeEnabled();

    // Current user's own disable button is disabled
    const mickyCard = screen.getByRole("article", { name: "账号 micky" });
    const buttons = mickyCard.querySelectorAll("button");
    const selfDisable = Array.from(buttons).find((btn) => btn.textContent === "停用账号");
    expect(selfDisable).toBeDisabled();
  });

  it("支持在网页端加密新建账号并展示一次性初始密码卡片（不发送明文密码）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: sampleOverview }))
      .mockImplementationOnce(() => jsonResponse({
        ok: true,
        data: { id: "teacher-new", username: "teacher_chen", role: "teacher", mustChangePassword: true },
      }, 201))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: sampleOverview }));

    const user = userEvent.setup();
    render(<AdminAccountsPage />);

    await screen.findByRole("heading", { name: "micky" });
    await user.click(screen.getByRole("button", { name: "+ 新建账号" }));

    const usernameInput = screen.getByPlaceholderText(/teacher_wang/u);
    await user.type(usernameInput, "Teacher_Chen");

    const passwordInput = screen.getByLabelText("初始登录密码");
    await user.clear(passwordInput);
    await user.type(passwordInput, "InitPass9876");

    await user.click(screen.getByRole("button", { name: "确认创建账号" }));

    expect(await screen.findByRole("heading", { name: "账号「teacher_chen」已创建" })).toBeInTheDocument();
    expect(screen.getByText("InitPass9876")).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const postCall = fetchMock.mock.calls[1];
    expect(postCall[0]).toBe("/api/admin/accounts");
    const sentBody = JSON.parse((postCall[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sentBody.username).toBe("teacher_chen");
    expect(sentBody.password).toBeUndefined();
    expect(typeof sentBody.salt).toBe("string");
    expect(typeof sentBody.verifier).toBe("string");
  });
});
