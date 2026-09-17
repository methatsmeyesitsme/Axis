import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface AuthUser {
  id: number;
  email: string;
  username: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  registerStart: (email: string, password: string) => Promise<void>;
  registerComplete: (username: string) => Promise<AuthUser>;
  checkUsername: (username: string) => Promise<{ available: boolean; reason?: string }>;
  refetch: () => Promise<void>;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiPost<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const responseText = await res.text();
  let data: { error?: string } & Partial<T> = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText) as { error?: string } & Partial<T>;
    } catch {
      throw new Error(`Server returned an invalid response (${res.status})`);
    }
  }
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  if (!responseText.trim()) throw new Error("Server returned an empty response");
  return data as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  const responseText = await res.text();
  let data: { error?: string } & Partial<T> = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText) as { error?: string } & Partial<T>;
    } catch {
      throw new Error(`Server returned an invalid response (${res.status})`);
    }
  }
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  if (!responseText.trim()) throw new Error("Server returned an empty response");
  return data as T;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const data = await apiGet<{ user: AuthUser | null }>("/api/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<AuthUser>("/api/auth/login", { email, password });
    setUser(data);
  }, []);

  const logout = useCallback(async () => {
    await apiPost("/api/auth/logout", {});
    setUser(null);
  }, []);

  const registerStart = useCallback(async (email: string, password: string) => {
    await apiPost("/api/auth/register/start", { email, password });
  }, []);

  const registerComplete = useCallback(async (username: string): Promise<AuthUser> => {
    const data = await apiPost<AuthUser>("/api/auth/register/complete", { username });
    setUser(data);
    return data;
  }, []);

  const checkUsername = useCallback(async (username: string) => {
    try {
      const data = await apiGet<{ available: boolean; reason?: string }>(
        `/api/auth/check-username?username=${encodeURIComponent(username)}`
      );
      return data;
    } catch {
      return { available: false };
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, registerStart, registerComplete, checkUsername, refetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
