import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { X, Eye, EyeOff, Check, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListOpenaiConversationsQueryKey } from "@workspace/api-client-react";

type Mode = "login" | "signup-step1" | "signup-step2";

interface AuthModalProps {
  onClose: () => void;
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function AuthModal({ onClose }: AuthModalProps) {
  const { login, registerStart, registerComplete, checkUsername } = useAuth();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<"idle" | "checking" | "taken" | "available" | "invalid">("idle");

  useEffect(() => {
    if (!username || mode !== "signup-step2") {
      setUsernameStatus("idle");
      return;
    }
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(username)) {
      setUsernameStatus("invalid");
      return;
    }
    setUsernameStatus("checking");
    const timer = setTimeout(async () => {
      const result = await checkUsername(username);
      setUsernameStatus(result.available ? "available" : "taken");
    }, 400);
    return () => clearTimeout(timer);
  }, [username, mode, checkUsername]);

  const handleLogin = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError("Please fill in all fields");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Please enter a valid email address");
      return;
    }
    setLoading(true);
    try {
      await login(email.trim(), password);
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? `[${err.name}] ${err.message}` : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSignupStep1 = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError("Please fill in all fields");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Please enter a valid email address");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    try {
      await registerStart(email.trim(), password);
      setMode("signup-step2");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSignupStep2 = async () => {
    setError(null);
    if (!username.trim()) {
      setError("Please choose a username");
      return;
    }
    if (usernameStatus === "taken") {
      setError("That username is already taken");
      return;
    }
    if (usernameStatus === "invalid") {
      setError("Username must be 2-32 characters (letters, numbers, underscores only)");
      return;
    }
    setLoading(true);
    try {
      await registerComplete(username.trim());
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (mode === "login") handleLogin();
      else if (mode === "signup-step1") handleSignupStep1();
      else handleSignupStep2();
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

        {mode !== "signup-step2" ? (
          <>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-foreground">
                {mode === "login" ? "Welcome back" : "Create your account"}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {mode === "login"
                  ? "Sign in to access your saved chats"
                  : "Save your chats and access them anywhere"}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">Password</label>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={mode === "login" ? "Your password" : "At least 6 characters"}
                    className="w-full px-3 py-2 pr-10 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <p className="mt-3 text-sm text-red-500">{error}</p>
            )}

            <Button
              className="w-full mt-5 bg-primary hover:bg-primary/90 text-white"
              onClick={mode === "login" ? handleLogin : handleSignupStep1}
              disabled={loading}
            >
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {mode === "login" ? "Sign in" : "Continue"}
            </Button>

            <p className="text-center text-sm text-muted-foreground mt-4">
              {mode === "login" ? (
                <>
                  Don't have an account?{" "}
                  <button
                    onClick={() => { setMode("signup-step1"); setError(null); }}
                    className="text-primary hover:underline font-medium"
                  >
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button
                    onClick={() => { setMode("login"); setError(null); }}
                    className="text-primary hover:underline font-medium"
                  >
                    Sign in
                  </button>
                </>
              )}
            </p>
          </>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-foreground">Choose a username</h2>
              <p className="text-sm text-muted-foreground mt-1">
                This is how you'll appear on CodeGen
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Username</label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. coolcoder_42"
                  className={`w-full px-3 py-2 pr-10 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 transition ${
                    usernameStatus === "taken" || usernameStatus === "invalid"
                      ? "border-red-400 focus:ring-red-400/30"
                      : usernameStatus === "available"
                      ? "border-green-500 focus:ring-green-500/30"
                      : "focus:ring-primary/50"
                  }`}
                  autoFocus
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {usernameStatus === "checking" && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                  {usernameStatus === "available" && <Check className="w-4 h-4 text-green-500" />}
                  {usernameStatus === "taken" && <X className="w-4 h-4 text-red-500" />}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {usernameStatus === "taken" && <span className="text-red-500">Username is already taken</span>}
                {usernameStatus === "invalid" && <span className="text-red-500">Letters, numbers, and underscores only (2-32 chars)</span>}
                {usernameStatus === "available" && <span className="text-green-600">Username is available!</span>}
                {(usernameStatus === "idle" || usernameStatus === "checking") && "Letters, numbers, and underscores only"}
              </p>
            </div>

            {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

            <Button
              className="w-full mt-5 bg-primary hover:bg-primary/90 text-white"
              onClick={handleSignupStep2}
              disabled={loading || usernameStatus === "taken" || usernameStatus === "invalid" || usernameStatus === "checking"}
            >
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create account
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
