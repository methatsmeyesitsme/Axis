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

const SESSION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_pkey";
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

function writeTableSqlFiles(): void {
  const candidates = [
    // Exact path from the ENOENT error on Replit
    path.join(process.cwd(), "artifacts/api-server/dist/table.sql"),
    path.join(process.cwd(), "dist/table.sql"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "table.sql"),
  ];
  for (const sqlPath of candidates) {
    try {
      fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
      fs.writeFileSync(sqlPath, SESSION_TABLE_SQL, "utf8");
      logger.info({ sqlPath }, "Ensured session table.sql");
    } catch (err) {
      logger.warn({ err, sqlPath }, "Could not write table.sql");
    }
  }
}

export async function ensureSessionTable(): Promise<void> {
  writeTableSqlFiles();

  // Create table with plain SQL — do not rely on connect-pg-simple reading table.sql
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

export function createApp(): Express {
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

  // createTableIfMissing must stay false — when true, the bundled/resolved path
  // looks for dist/table.sql and can still throw ENOENT even after we write it.
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

  return app;
}

// Default export kept for typecheck / accidental imports; prefer createApp().
export default createApp();
