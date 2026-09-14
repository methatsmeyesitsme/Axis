import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const isHttps =
  process.env.NODE_ENV === "production" ||
  !!process.env.REPLIT_DEV_DOMAIN ||
  !!process.env.REPL_SLUG;

const SESSION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

/**
 * Bundled builds rewrite __dirname to dist/, so connect-pg-simple may look for
 * dist/table.sql. Ensure that file exists, and create the table via SQL too.
 */
export async function ensureSessionTable(): Promise<void> {
  try {
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlPath = path.join(distDir, "table.sql");
    if (!fs.existsSync(sqlPath)) {
      fs.writeFileSync(sqlPath, SESSION_TABLE_SQL, "utf8");
      logger.info({ sqlPath }, "Wrote missing session table.sql");
    }
  } catch (err) {
    logger.warn({ err }, "Could not write dist/table.sql (non-fatal)");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
  `);
}

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: false,
    }),
    secret: process.env["SESSION_SECRET"] ?? "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    rolling: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      path: "/",
    },
  }),
);

app.use("/api", router);

const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  req.log?.error({ err }, "[api-server] Unhandled route error");
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
};
app.use(jsonErrorHandler);

export default app;
