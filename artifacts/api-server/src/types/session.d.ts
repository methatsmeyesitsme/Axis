import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    pendingEmail?: string;
    pendingPasswordHash?: string;
    githubOAuthState?: string;
    githubOAuthReturnTo?: string;
  }
}
