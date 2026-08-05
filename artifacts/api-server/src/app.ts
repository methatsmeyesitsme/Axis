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

app.use(
  session({
    store: new PgSession({ pool, tableName: "session" }),
    secret: process.env["SESSION_SECRET"] ?? "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

app.use("/api", router);

// Without this, an uncaught exception anywhere in a route (e.g. a transient
// DB error) falls through to Express's default handler, which returns an
// HTML error page. Clients calling res.json() on that get a confusing
// SyntaxError ("...did not match the expected pattern" on WebKit) instead
// of a real error message. This guarantees every response is valid JSON.
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
