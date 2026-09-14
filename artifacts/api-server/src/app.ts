import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Replit / reverse proxies terminate TLS — required for secure cookies to stick.
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

app.use(
  session({
    store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
    name: "axis.sid",
    secret: process.env["SESSION_SECRET"] ?? "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    rolling: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — stay logged in across restarts
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
