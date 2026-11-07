/**
 * 독자 세션: GET /api/session at start. When the API is not there (plain static hosting), the site is read-only:
 * likes / comments / ratings are hidden (`available = false`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionDto } from "../../server/api-types.js";
import { api } from "./data.js";

interface SessionValue {
  /** null until known */
  available: boolean | null;
  nickname: string | null;
  login(nickname: string, password: string): Promise<void>;
  signup(nickname: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** open the login sheet (e.g. a like tapped while logged out); `then` runs after a successful login */
  requireLogin(then?: () => void): void;
  loginOpen: boolean;
  closeLogin(): void;
  afterLogin(): void;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [nickname, setNickname] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);

  useEffect(() => {
    api<SessionDto>("GET", "/session").then(
      (s) => {
        setAvailable(true);
        setNickname(s.reader?.nickname ?? null);
      },
      () => setAvailable(false),
    );
  }, []);

  const apply = (s: SessionDto) => setNickname(s.reader?.nickname ?? null);
  const login = useCallback(async (n: string, p: string) => apply(await api<SessionDto>("POST", "/login", { nickname: n, password: p })), []);
  const signup = useCallback(async (n: string, p: string) => apply(await api<SessionDto>("POST", "/signup", { nickname: n, password: p })), []);
  const logout = useCallback(async () => apply(await api<SessionDto>("POST", "/logout")), []);
  const requireLogin = useCallback((then?: () => void) => {
    setPending(() => then ?? null);
    setLoginOpen(true);
  }, []);
  const closeLogin = useCallback(() => {
    setLoginOpen(false);
    setPending(null);
  }, []);
  const afterLogin = useCallback(() => {
    setLoginOpen(false);
    const fn = pending;
    setPending(null);
    fn?.();
  }, [pending]);

  const value = useMemo<SessionValue>(
    () => ({ available, nickname, login, signup, logout, requireLogin, loginOpen, closeLogin, afterLogin }),
    [available, nickname, login, signup, logout, requireLogin, loginOpen, closeLogin, afterLogin],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("SessionProvider missing");
  return v;
}
