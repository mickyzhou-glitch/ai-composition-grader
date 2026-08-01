"use client";

import { useEffect, useState, type PropsWithChildren } from "react";

import { ApiError, apiFetch } from "../lib/api";
import { replaceDocument } from "../lib/document-navigation";
import { AuthUserProvider } from "./AuthUserContext";

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
};

export function RequireAuthenticatedUser({ children, requireAdmin = false }: PropsWithChildren<{ requireAdmin?: boolean }>) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let verification = 0;
    const verifyAuthentication = async () => {
      const currentVerification = ++verification;
      setUser(null);
      setFailed(false);
      try {
        const nextUser = await apiFetch<CurrentUser>("/api/auth/me");
        if (!active || currentVerification !== verification) return;
        if (nextUser.mustChangePassword) {
          replaceDocument("/change-password");
          return;
        }
        setUser(nextUser);
      } catch (error: unknown) {
        if (!active || currentVerification !== verification) return;
        if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
          replaceDocument("/login");
          return;
        }
        setFailed(true);
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void verifyAuthentication();
    };
    void verifyAuthentication();
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      active = false;
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  if (failed) return <main className="auth-page"><p className="error-banner" role="alert">认证服务暂时不可用，请稍后重试。</p></main>;
  if (!user) return <main aria-busy="true" />;
  if (requireAdmin && user.role !== "admin") {
    return <main className="auth-page"><p className="error-banner" role="alert">没有权限访问此页面</p></main>;
  }
  return <AuthUserProvider role={user.role}>{children}</AuthUserProvider>;
}
