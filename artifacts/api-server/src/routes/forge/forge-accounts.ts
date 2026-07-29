import { db, forgeAppEndUsers, forgeAppSessions } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

// Accounts here are scoped per Forge *app* (forgeAppEndUsers/forgeAppSessions),
// entirely separate from the platform's own users table used for Axis/Cortex
// login — a generated app's end users have nothing to do with who's logged
// into the builder itself.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ForgeAuthUser {
  id: number;
  email: string;
}

type AuthResult = { user: ForgeAuthUser; token: string } | { error: string };

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function createSession(appId: number, endUserId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(forgeAppSessions).values({ token, appId, endUserId, expiresAt });
  return token;
}

export async function signup(appId: number, email: string, password: string): Promise<AuthResult> {
  if (!isValidEmail(email)) return { error: "Invalid email address" };
  if (typeof password !== "string" || password.length < 6) {
    return { error: "Password must be at least 6 characters" };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const [existing] = await db
    .select()
    .from(forgeAppEndUsers)
    .where(and(eq(forgeAppEndUsers.appId, appId), eq(forgeAppEndUsers.email, normalizedEmail)));
  if (existing) return { error: "An account with this email already exists" };

  const passwordHash = await bcrypt.hash(password, 10);
  const [created] = await db
    .insert(forgeAppEndUsers)
    .values({ appId, email: normalizedEmail, passwordHash })
    .returning();

  const token = await createSession(appId, created.id);
  return { user: { id: created.id, email: created.email }, token };
}

export async function login(appId: number, email: string, password: string): Promise<AuthResult> {
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: "Email and password required" };
  }

  const normalizedEmail = email.toLowerCase().trim();
  const [row] = await db
    .select()
    .from(forgeAppEndUsers)
    .where(and(eq(forgeAppEndUsers.appId, appId), eq(forgeAppEndUsers.email, normalizedEmail)));
  if (!row) return { error: "Invalid email or password" };

  const valid = await bcrypt.compare(password, row.passwordHash);
  if (!valid) return { error: "Invalid email or password" };

  const token = await createSession(appId, row.id);
  return { user: { id: row.id, email: row.email }, token };
}

export async function getSessionUser(appId: number, token: string | undefined): Promise<ForgeAuthUser | null> {
  if (!token) return null;

  const [session] = await db
    .select()
    .from(forgeAppSessions)
    .where(and(eq(forgeAppSessions.token, token), eq(forgeAppSessions.appId, appId), gt(forgeAppSessions.expiresAt, new Date())));
  if (!session) return null;

  const [user] = await db.select().from(forgeAppEndUsers).where(eq(forgeAppEndUsers.id, session.endUserId));
  if (!user) return null;

  return { id: user.id, email: user.email };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(forgeAppSessions).where(eq(forgeAppSessions.token, token));
}
