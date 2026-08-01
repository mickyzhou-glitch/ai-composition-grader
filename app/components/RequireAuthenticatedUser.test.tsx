import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "../lib/api";
import { RequireAuthenticatedUser } from "./RequireAuthenticatedUser";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  replaceDocument: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock("../lib/document-navigation", () => ({ replaceDocument: navigation.replaceDocument }));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, apiFetch: vi.fn() };
});

describe("RequireAuthenticatedUser", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    navigation.replaceDocument.mockReset();
    vi.mocked(apiFetch).mockReset();
  });

  it("redirects an unauthenticated browser to login", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("Authentication required", 401, "UNAUTHENTICATED"));

    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);

    await waitFor(() => expect(navigation.replaceDocument).toHaveBeenCalledWith("/login"));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("renders protected content and the user role after authentication", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false });

    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);

    expect(await screen.findByText("private")).toBeInTheDocument();
  });

  it("loads the password-change document when the user must replace their password", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: true });

    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);

    await waitFor(() => expect(navigation.replaceDocument).toHaveBeenCalledWith("/change-password"));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("hides admin-only content from a teacher", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false });

    render(<RequireAuthenticatedUser requireAdmin><p>settings</p></RequireAuthenticatedUser>);

    expect(await screen.findByText("没有权限访问此页面")).toBeInTheDocument();
    expect(screen.queryByText("settings")).not.toBeInTheDocument();
  });

  it("revalidates a protected document restored from the back-forward cache", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false })
      .mockRejectedValueOnce(new ApiError("Authentication required", 401, "UNAUTHENTICATED"));
    render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);
    expect(await screen.findByText("private")).toBeInTheDocument();

    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    window.dispatchEvent(pageShow);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("private")).not.toBeInTheDocument();
    expect(navigation.replaceDocument).toHaveBeenCalledWith("/login");
  });
});
