import { Router, type IRouter } from "express";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const router: IRouter = Router();

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPassword(pw: string) {
  return typeof pw === "string" && pw.length >= 6;
}
function isValidUsername(u: string) {
  return typeof u === "string" && /^[a-zA-Z0-9_]{2,32}$/.test(u);
}

router.post("/register/start", async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (!isValidPassword(password)) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (existing.length > 0) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  req.session.pendingEmail = email.toLowerCase();
  req.session.pendingPasswordHash = hash;
  res.json({ ok: true });
});

router.post("/register/complete", async (req, res) => {
  const { username } = req.body as { username: string };

  if (!req.session.pendingEmail || !req.session.pendingPasswordHash) {
    res.status(400).json({ error: "Session expired. Please start registration again." });
    return;
  }

  if (!isValidUsername(username)) {
    res.status(400).json({ error: "Username must be 2-32 characters (letters, numbers, underscores only)" });
    return;
  }

  const existingUsername = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
  if (existingUsername.length > 0) {
    res.status(409).json({ error: "Username is already taken" });
    return;
  }

  const [newUser] = await db.insert(users).values({
    email: req.session.pendingEmail,
    username: username.toLowerCase(),
    passwordHash: req.session.pendingPasswordHash,
  }).returning();

  req.session.pendingEmail = undefined;
  req.session.pendingPasswordHash = undefined;
  req.session.userId = newUser.id;

  res.json({ id: newUser.id, email: newUser.email, username: newUser.username });
});

router.get("/check-username", async (req, res) => {
  const { username } = req.query as { username: string };
  if (!username) {
    res.status(400).json({ error: "Username required" });
    return;
  }
  if (!isValidUsername(username)) {
    res.json({ available: false, reason: "Invalid format" });
    return;
  }
  const existing = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
  res.json({ available: existing.length === 0 });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email, username: user.username });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res) => {
  if (!req.session.userId) {
    res.json({ user: null });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));
  if (!user) {
    req.session.userId = undefined;
    res.json({ user: null });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, username: user.username } });
});

export default router;
