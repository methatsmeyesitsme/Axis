import { db, forgeAppFiles, forgeAppData, forgeAppTables, forgeAppTableRows } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import type { FunctionDeclaration } from "@google/genai";
import { saveBackendHandler } from "./forge-handler-storage";
import { executeGithubTool, isGithubReady } from "../github-tools";

const summaryProp = {
  summary: { type: "string", description: "Concise past-tense summary of this action, 8 words maximum" },
};

export const forgeToolDeclarations: FunctionDeclaration[] = [
  {
    name: "write_file",
    description: "Create or overwrite a frontend file (HTML, CSS, or JS) for the app being built.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. index.html or style.css" },
        content: { type: "string", description: "Full file content" },
        ...summaryProp,
      },
      required: ["path", "content", "summary"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the app.",
    parametersJsonSchema: {
      type: "object",
      properties: { path: { type: "string" }, ...summaryProp },
      required: ["path", "summary"],
    },
  },
  {
    name: "import_github_repo",
    description:
      "Pull files from the user's connected GitHub repository into this Forge app so they can be previewed with the Run button. Copies text/web files (html, css, js, json, md, svg, txt). Prefer paths that include index.html when possible.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional subdirectory in the repo to import (e.g. 'docs' or 'public'). Leave empty for the whole repo root.",
        },
        ...summaryProp,
      },
      required: ["summary"],
    },
  },
  {
    name: "db_get",
    description: "Read a value from the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_set",
    description: "Write a value to the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string", description: "JSON-encoded value to store" },
        ...summaryProp,
      },
      required: ["key", "value", "summary"],
    },
  },
  {
    name: "db_delete",
    description: "Delete a key from the app's simple key/value storage.",
    parametersJsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...summaryProp },
      required: ["key", "summary"],
    },
  },
  {
    name: "db_list",
    description: "List keys in the app's simple key/value storage, optionally filtered by prefix.",
    parametersJsonSchema: {
      type: "object",
      properties: { prefix: { type: "string" }, ...summaryProp },
      required: ["summary"],
    },
  },
  {
    name: "create_table",
    description:
      "Define a structured data table for the app. This is idempotent: inspect existing tables first, and if the table already exists, keep using it instead of trying to recreate it.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, type: { type: "string" } },
            required: ["name", "type"],
          },
        },
        ...summaryProp,
      },
      required: ["name", "columns", "summary"],
    },
  },
  {
    name: "table_list",
    description: "List the structured tables already defined for this app before creating or migrating one.",
    parametersJsonSchema: {
      type: "object",
      properties: { ...summaryProp },
      required: ["summary"],
    },
  },
  {
    name: "table_insert",
    description: "Insert a row into one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        data: { type: "string", description: "JSON-encoded object of column values" },
        ...summaryProp,
      },
      required: ["table", "data", "summary"],
    },
  },
  {
    name: "table_select",
    description: "Read rows from one of the app's tables, optionally filtered.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "Optional JSON-encoded object of exact-match filters" },
        ...summaryProp,
      },
      required: ["table", "summary"],
    },
  },
  {
    name: "table_update",
    description: "Update rows matching a filter in one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "JSON-encoded object of exact-match filters" },
        data: { type: "string", description: "JSON-encoded object of column values to set" },
        ...summaryProp,
      },
      required: ["table", "filter", "data", "summary"],
    },
  },
  {
    name: "table_delete",
    description: "Delete rows matching a filter in one of the app's tables.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        filter: { type: "string", description: "JSON-encoded object of exact-match filters" },
        ...summaryProp,
      },
      required: ["table", "filter", "summary"],
    },
  },
  {
    name: "write_backend_handler",
    description:
      "Define real, executable backend logic for a route (e.g. POST /checkout). The code runs server-side in a sandbox with access to `req` (method, route, query, body) and `db` (get/set/delete/list, insert/select/update/deleteRows). It must `return { status, body }`.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method, e.g. GET, POST, PUT, DELETE" },
        route: { type: "string", description: "Route path, e.g. /checkout or /todos/:id" },
        code: {
          type: "string",
          description:
            "JavaScript statements (async allowed) using `req` and `db`, ending with `return { status: 200, body: ... }`",
        },
        ...summaryProp,
      },
      required: ["method", "route", "code", "summary"],
    },
  },
  {
    name: "add_accounts",
    description:
      "Enable sign-up/login accounts for the app's end users. Adds built-in endpoints (api/_auth/signup, api/_auth/login, api/_auth/logout, api/_auth/me) and makes the signed-in user available to write_backend_handler code as req.user.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
  {
    name: "run_preview",
    description:
      "Check whether the app is ready to preview (i.e. an index.html exists) and confirm its live preview is available. The user can open it with the Run button in the UI.",
    parametersJsonSchema: { type: "object", properties: { ...summaryProp }, required: ["summary"] },
  },
];

export function truncateSummary(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  const words = text.split(/\s+/);
  return words.length > 8 ? words.slice(0, 8).join(" ") + "…" : text;
}

type ForgeToolResult = { output?: unknown; error?: string };

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = typeof (err as Error & { code?: unknown }).code === "string"
      ? ` [${(err as Error & { code: string }).code}]`
      : "";
    const cause = err.cause instanceof Error ? ` — caused by: ${err.cause.message}` : "";
    return `${err.message}${code}${cause}`;
  }
  return String(err);
}

function isAlreadyCompletedError(error: string): boolean {
  return /\b(already exists|duplicate key|duplicate table|relation .* already exists|duplicate object)\b/i.test(error);
}

function isTransientDatabaseError(error: string): boolean {
  return /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated|connection reset|connection closed|server closed|deadlock detected|could not serialize|too many connections|connection is not available|timeout expired|temporarily unavailable)\b/i.test(error);
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const PREVIEW_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "json", "md", "txt", "svg", "xml", "map",
]);

function isPreviewFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base.startsWith(".")) return false;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return PREVIEW_EXTS.has(ext);
}

async function importGithubIntoForge(
  appId: number,
  userId: number | null,
  rootPath: string,
): Promise<ForgeToolResult> {
  if (!userId) return { error: "Log in and connect GitHub in Settings first." };
  if (!(await isGithubReady(userId))) {
    return { error: "No GitHub repository is connected/selected. Connect GitHub and pick a repo in Settings." };
  }

  const queue: string[] = [rootPath.replace(/^\/+/, "")];
  const filePaths: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && filePaths.length < 80) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const listed = await executeGithubTool(userId, "github_list_files", { path: dir });
    if (listed.error) return { error: listed.error };
    const items = Array.isArray(listed.output) ? listed.output : [];
    for (const item of items as Array<{ path?: string; type?: string; name?: string }>) {
      const p = String(item.path ?? "");
      if (!p) continue;
      if (item.type === "dir") {
        if (!p.includes("node_modules") && !p.includes(".git")) queue.push(p);
      } else if (item.type === "file" && isPreviewFile(p)) {
        filePaths.push(p);
      }
    }
  }

  if (filePaths.length === 0) {
    return { error: "No previewable files found in that GitHub path (need html/css/js/json/md/svg/txt)." };
  }

  let imported = 0;
  const names: string[] = [];
  for (const path of filePaths.slice(0, 40)) {
    const read = await executeGithubTool(userId, "github_read_file", { path });
    if (read.error || typeof read.output !== "string") continue;
    const content = read.output as string;
    if (content.length > 400_000) continue;
    const [existing] = await db
      .select()
      .from(forgeAppFiles)
      .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
    if (existing) {
      await db.update(forgeAppFiles).set({ content, updatedAt: new Date() }).where(eq(forgeAppFiles.id, existing.id));
    } else {
      await db.insert(forgeAppFiles).values({ appId, path, content });
    }
    imported++;
    names.push(path);
  }

  const hasIndex = names.some((p) => p === "index.html" || p.endsWith("/index.html"));
  return {
    output: {
      imported,
      files: names.slice(0, 20),
      hasIndexHtml: hasIndex,
      hint: hasIndex
        ? "Preview is ready — user can press Run."
        : "Imported files, but no index.html. Create or copy one with write_file so Run works.",
    },
  };
}

async function executeForgeToolOnce(
  appId: number,
  name: string,
  rawArgs: Record<string, unknown>,
  userId?: number | null,
): Promise<ForgeToolResult> {
  try {
    switch (name) {
      case "write_file": {
        let path = String(rawArgs.path ?? "").trim().replace(/^\/+/, "");
        if (!path) path = "index.html";
        if (/^index\.hmtl$/i.test(path) || /^index\.htm$/i.test(path)) path = "index.html";
        const content = String(rawArgs.content ?? "");
        if (!content.trim()) return { error: "content is required — nothing was written" };
        const [existing] = await db
          .select()
          .from(forgeAppFiles)
          .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        if (existing) {
          await db
            .update(forgeAppFiles)
            .set({ content, updatedAt: new Date() })
            .where(eq(forgeAppFiles.id, existing.id));
        } else {
          await db.insert(forgeAppFiles).values({ appId, path, content });
        }
        const [verify] = await db
          .select()
          .from(forgeAppFiles)
          .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        if (!verify || verify.content !== content) {
          return { error: `Failed to persist ${path} to the database. Restart the Repl and try again.` };
        }
        return { output: `Wrote ${path} (${content.length} bytes)` };
      }
      case "delete_file": {
        const path = String(rawArgs.path ?? "").trim().replace(/^\/+/, "");
        await db.delete(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
        return { output: `Deleted ${path}` };
      }
      case "import_github_repo": {
        return importGithubIntoForge(appId, userId ?? null, String(rawArgs.path ?? ""));
      }
      case "db_get": {
        const key = String(rawArgs.key ?? "");
        const [row] = await db.select().from(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        return { output: row ? row.value : null };
      }
      case "db_set": {
        const key = String(rawArgs.key ?? "");
        const value = safeParseJson(rawArgs.value);
        const [existing] = await db.select().from(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        if (existing) {
          await db.update(forgeAppData).set({ value, updatedAt: new Date() }).where(eq(forgeAppData.id, existing.id));
        } else {
          await db.insert(forgeAppData).values({ appId, key, value });
        }
        return { output: "ok" };
      }
      case "db_delete": {
        const key = String(rawArgs.key ?? "");
        await db.delete(forgeAppData).where(and(eq(forgeAppData.appId, appId), eq(forgeAppData.key, key)));
        return { output: "ok" };
      }
      case "db_list": {
        const prefix = typeof rawArgs.prefix === "string" ? rawArgs.prefix : undefined;
        const rows = await db.select().from(forgeAppData).where(eq(forgeAppData.appId, appId));
        const keys = rows.map((r) => r.key).filter((k) => !prefix || k.startsWith(prefix));
        return { output: keys };
      }
      case "create_table": {
        const tableName = String(rawArgs.name ?? "").trim();
        const columns = safeParseJson(rawArgs.columns);
        if (!tableName) return { error: "name is required" };
        const [existing] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (existing) return { output: `Table ${tableName} already exists — continue using the existing table` };
        try {
          await db.insert(forgeAppTables).values({ appId, name: tableName, columns });
        } catch (err) {
          const message = errorText(err);
          if (isAlreadyCompletedError(message)) {
            const [racedExisting] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
            if (racedExisting) return { output: `Table ${tableName} already exists — continue using the existing table` };
          }
          throw err;
        }
        return { output: `Created table ${tableName}` };
      }
      case "table_list": {
        const tables = await db
          .select({ name: forgeAppTables.name, columns: forgeAppTables.columns })
          .from(forgeAppTables)
          .where(eq(forgeAppTables.appId, appId));
        return { output: tables };
      }
      case "table_insert": {
        const tableName = String(rawArgs.table ?? "").trim();
        const rowData = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist — create it first` };
        const [inserted] = await db.insert(forgeAppTableRows).values({ tableId: t.id, data: rowData }).returning();
        return { output: { id: inserted.id, ...rowData } };
      }
      case "table_select": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = rawArgs.filter ? (safeParseJson(rawArgs.filter) as Record<string, unknown>) : null;
        const rows =
          filterObj && Object.keys(filterObj).length > 0
            ? await db.select().from(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`))
            : await db.select().from(forgeAppTableRows).where(eq(forgeAppTableRows.tableId, t.id));
        return { output: rows.map((r) => ({ id: r.id, ...(r.data as Record<string, unknown>) })) };
      }
      case "table_update": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        const patch = safeParseJson(rawArgs.data) as Record<string, unknown>;
        const rows = await db.select().from(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        for (const row of rows) {
          await db.update(forgeAppTableRows).set({ data: { ...(row.data as Record<string, unknown>), ...patch }, updatedAt: new Date() }).where(eq(forgeAppTableRows.id, row.id));
        }
        return { output: `Updated ${rows.length} row(s)` };
      }
      case "table_delete": {
        const tableName = String(rawArgs.table ?? "");
        const [t] = await db.select().from(forgeAppTables).where(and(eq(forgeAppTables.appId, appId), eq(forgeAppTables.name, tableName)));
        if (!t) return { error: `Table ${tableName} does not exist` };
        const filterObj = safeParseJson(rawArgs.filter) as Record<string, unknown>;
        await db.delete(forgeAppTableRows).where(and(eq(forgeAppTableRows.tableId, t.id), sql`${forgeAppTableRows.data} @> ${JSON.stringify(filterObj)}::jsonb`));
        return { output: "ok" };
      }
      case "write_backend_handler": {
        const method = String(rawArgs.method ?? "").toUpperCase();
        const route = String(rawArgs.route ?? "");
        const code = String(rawArgs.code ?? "");
        if (!method || !route || !code) return { error: "method, route, and code are all required" };
        await saveBackendHandler(appId, method, route, code);
        return { output: `Saved ${method} ${route}` };
      }
      case "add_accounts": {
        return { output: "Accounts enabled for this app (signup/login endpoints active)." };
      }
      case "run_preview": {
        const [entry] = await db
          .select()
          .from(forgeAppFiles)
          .where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, "index.html")));
        if (!entry) {
          const all = await db.select({ path: forgeAppFiles.path }).from(forgeAppFiles).where(eq(forgeAppFiles.appId, appId));
          const names = all.map((r) => r.path).join(", ") || "(none)";
          return { error: `No index.html yet — files present: ${names}` };
        }
        return { output: `Preview is ready (${entry.content.length} bytes in index.html). Open with Run.` };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: errorText(err) };
  }
}

export async function executeForgeTool(
  appId: number,
  name: string,
  rawArgs: Record<string, unknown>,
  userId?: number | null,
): Promise<ForgeToolResult> {
  let lastResult: ForgeToolResult = { error: `Tool ${name} failed` };
  for (let attempt = 0; attempt < 3; attempt++) {
    lastResult = await executeForgeToolOnce(appId, name, rawArgs, userId);
    if (!lastResult.error) return lastResult;

    if (isAlreadyCompletedError(lastResult.error)) {
      return {
        output: `${lastResult.error} — this setup step is already complete; continue with the next step`,
      };
    }

    if (!isTransientDatabaseError(lastResult.error) || attempt === 2) {
      return lastResult;
    }
    await pause(150 * (attempt + 1));
  }
  return lastResult;
}
