"use client";

import { createContext, useCallback, useContext, useEffect, useState, type PropsWithChildren } from "react";


interface PendingRulesState {
  count: number;
  refresh(): void;
}

const PendingRulesContext = createContext<PendingRulesState | undefined>(undefined);

/** 登录后读取待审批候选规则数量，供导航小红点使用；读取失败按 0 处理。 */
export function PendingRulesProvider({ children }: PropsWithChildren) {
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => {
    // 直接用 fetch：小红点是附带信息，不参与登录校验流程。
    void fetch("/api/rule-candidates?count=1", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{ data?: { pending?: number } }> : null)
      .then((body) => setCount(Number(body?.data?.pending) || 0))
      .catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return <PendingRulesContext.Provider value={{ count, refresh }}>{children}</PendingRulesContext.Provider>;
}

export function usePendingRules(): PendingRulesState | undefined {
  return useContext(PendingRulesContext);
}
