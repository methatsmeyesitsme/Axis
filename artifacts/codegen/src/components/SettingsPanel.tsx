import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { X, Sun, Moon, LogOut, User, Mail, Lock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

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
