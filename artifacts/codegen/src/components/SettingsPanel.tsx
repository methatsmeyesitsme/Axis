import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { X, Sun, Moon, LogOut, User, Mail, Lock, Github, Loader2, Unlink, Copy, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

interface GithubStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  selectedOwner?: string | null;
  selectedRepo?: string | null;
  selectedBranch?: string | null;
}

interface GithubRepo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

interface SettingsPanelProps {
  onClose: () => void;
}

function getStoredTheme(): "light" | "dark" {
  return (localStorage.getItem("theme") as "light" | "dark") ?? "light";
}

function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  localStorage.setItem("theme", theme);
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<"light" | "dark">(getStoredTheme);
  const [loggingOut, setLoggingOut] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [githubRepos, setGithubRepos] = useState<GithubRepo[] | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubCallbackUrl, setGithubCallbackUrl] = useState<string | null>(null);
  const [callbackCopied, setCallbackCopied] = useState(false);

  useEffect(() => {
    fetch("/api/github/oauth/config", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { callbackUrl?: string } | null) => setGithubCallbackUrl(data?.callbackUrl ?? null))
      .catch(() => setGithubCallbackUrl(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    fetch("/api/github/status", { credentials: "include" })
      .then((r) => r.json())
      .then((data: GithubStatus) => {
        setGithubStatus(data);
        if (data.connected) {
          fetch("/api/github/repos", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : []))
            .then(setGithubRepos)
            .catch(() => setGithubRepos([]));
        }
      })
      .catch(() => setGithubStatus({ connected: false }));
  }, [user]);

  const handleConnectGithub = () => {
    window.location.href = `/api/github/oauth/start?returnTo=${encodeURIComponent(window.location.pathname)}`;
  };

  const handleDisconnectGithub = async () => {
    setGithubBusy(true);
    try {
      await fetch("/api/github/disconnect", { method: "POST", credentials: "include" });
      setGithubStatus({ connected: false });
      setGithubRepos(null);
    } finally {
      setGithubBusy(false);
    }
  };

  const handleSelectRepo = async (fullName: string) => {
    const match = githubRepos?.find((r) => r.fullName === fullName);
    if (!match) return;
    setGithubBusy(true);
    try {
      await fetch("/api/github/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ owner: match.owner, repo: match.repo, branch: match.defaultBranch }),
      });
      setGithubStatus((prev) => (prev ? { ...prev, selectedOwner: match.owner, selectedRepo: match.repo, selectedBranch: match.defaultBranch } : prev));
    } finally {
      setGithubBusy(false);
    }
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const handleThemeToggle = (newTheme: "light" | "dark") => {
    setTheme(newTheme);
    applyTheme(newTheme);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      queryClient.clear();
      onClose();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-background border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 className="text-xl font-semibold text-foreground mb-6">Settings</h2>

        {user && (
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Account
            </h3>
            <div className="space-y-3 bg-muted/40 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <User className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Username</p>
                  <p className="text-sm font-medium">{user.username}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-sm font-medium">{user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Lock className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Password</p>
                  <p className="text-sm font-medium">••••••••</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {user && (
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              GitHub
            </h3>
            {!githubStatus ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : githubStatus.connected ? (
              <div className="space-y-3 bg-muted/40 rounded-xl p-4">
                <div className="flex items-center gap-3">
                  {githubStatus.avatarUrl ? (
                    <img src={githubStatus.avatarUrl} alt={githubStatus.login} className="w-8 h-8 rounded-full shrink-0" />
                  ) : (
                    <Github className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">Connected as</p>
                    <p className="text-sm font-medium truncate">{githubStatus.login}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-red-500 shrink-0"
                    onClick={handleDisconnectGithub}
                    disabled={githubBusy}
                    title="Disconnect GitHub"
                  >
                    <Unlink className="w-4 h-4" />
                  </Button>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Repository</label>
                  <select
                    value={githubStatus.selectedOwner && githubStatus.selectedRepo ? `${githubStatus.selectedOwner}/${githubStatus.selectedRepo}` : ""}
                    onChange={(e) => handleSelectRepo(e.target.value)}
                    disabled={githubBusy || !githubRepos}
                    className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition"
                  >
                    <option value="" disabled>
                      {githubRepos ? "Choose a repository…" : "Loading repositories…"}
                    </option>
                    {githubRepos?.map((r) => (
                      <option key={r.fullName} value={r.fullName}>
                        {r.fullName}
                      </option>
                    ))}
                  </select>
                  {githubStatus.selectedBranch && (
                    <p className="text-xs text-muted-foreground mt-1.5">Branch: {githubStatus.selectedBranch}</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleConnectGithub}
                >
                  <Github className="w-4 h-4 mr-2" />
                  Connect GitHub
                </Button>
                {githubCallbackUrl && (
                  <div className="rounded-xl border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        In your GitHub OAuth App, set the callback URL to this exact stable URL:
                      </p>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        title="Copy callback URL"
                        onClick={() => {
                          void navigator.clipboard.writeText(githubCallbackUrl);
                          setCallbackCopied(true);
                          window.setTimeout(() => setCallbackCopied(false), 1500);
                        }}
                      >
                        {callbackCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <code className="block mt-2 text-[11px] leading-relaxed break-all text-foreground/80">
                      {githubCallbackUrl}
                    </code>
                    <p className="text-[11px] text-muted-foreground mt-2">
                      Axis keeps the current preview page as the return destination, so preview URLs can change without changing this GitHub setting.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mb-6">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Appearance
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => handleThemeToggle("light")}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border text-sm font-medium transition-all ${
                theme === "light"
                  ? "bg-primary text-white border-primary shadow-sm"
                  : "bg-background text-foreground hover:bg-muted border-border"
              }`}
            >
              <Sun className="w-4 h-4" />
              Light
            </button>
            <button
              onClick={() => handleThemeToggle("dark")}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border text-sm font-medium transition-all ${
                theme === "dark"
                  ? "bg-primary text-white border-primary shadow-sm"
                  : "bg-background text-foreground hover:bg-muted border-border"
              }`}
            >
              <Moon className="w-4 h-4" />
              Dark
            </button>
          </div>
        </div>

        {user && (
          <Button
            variant="outline"
            className="w-full text-red-500 border-red-200 hover:bg-red-50 hover:border-red-300 dark:hover:bg-red-950/20"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <LogOut className="w-4 h-4 mr-2" />
            {loggingOut ? "Signing out…" : "Sign out"}
          </Button>
        )}
      </div>
    </div>
  );
}
