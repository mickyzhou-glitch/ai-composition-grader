"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";


interface PendingRulesState {
  count: number;
  refresh(): void;
}

const PendingRulesContext = createContext<PendingRulesState | undefined>(undefined);

/** 登录后读取待审批候选规则数量，供导航小红点使用；读取失败按 0 处理。 */
export function PendingRulesProvider({ children }: PropsWithChildren) {
  const [count, setCount] = useState(0);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    // 直接用 fetch：小红点是附带信息，不参与登录校验流程。
    void fetch("/api/rule-candidates?count=1", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{ data?: { pending?: number } }> : null)
      .then((body) => {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setCount(Number(body?.data?.pending) || 0);
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);
  return <PendingRulesContext.Provider value={{ count, refresh }}>{children}</PendingRulesContext.Provider>;
}

export function usePendingRules(): PendingRulesState | undefined {
  return useContext(PendingRulesContext);
}
