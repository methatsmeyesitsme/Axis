import vm from "node:vm";
import { db as realDb, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { executeForgeTool } from "./forge-tools";
import { handlerFilePath } from "./forge-handler-storage";

interface SandboxRequest {
  method: string;
  route: string;
  query: Record<string, string>;
  body: unknown;
  user?: { id: number; email: string } | null;
}

interface SandboxResult {
  status: number;
  body: unknown;
  error?: string;
  logs: string[];
}

const SYNC_TIMEOUT_MS = 2000; // stops CPU-bound infinite loops (vm's own timeout)
const WALL_CLOCK_TIMEOUT_MS = 5000; // stops async/I/O hangs (our own race, since vm's timeout doesn't cover awaited time)

/**
 * Executes a generated app's backend handler in a sandboxed vm context.
 *
 * Security model (intentionally documented, not oversold): this is a *soft*
 * sandbox. It blocks the obvious escape routes (no require/process/filesystem
 * access, no network, isolated per-call context, both a sync and a wall-clock
 * timeout) and is a real safety improvement over running arbitrary AI-written
 * code directly in-process. It is NOT a hard security boundary the way an
 * actual container/VM would be — Node's vm module is explicitly documented as
 * not secure against a sufficiently determined attacker. Good against
 * accidents and casual misuse; not a substitute for real isolation if this
 * ever needs to withstand adversarial input.
 */
export async function executeBackendHandler(appId: number, req: SandboxRequest): Promise<SandboxResult> {
  const path = handlerFilePath(req.method, req.route);
  const [file] = await realDb.select().from(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));

  if (!file) {
    return { status: 404, body: { error: "No handler defined for this route" }, logs: [] };
  }

  const logs: string[] = [];

  // The db API exposed inside the sandbox — thin wrappers around the same
  // safe, parameterized operations used by the AI's own tools. No raw SQL is
  // ever reachable from sandboxed code.
  const sandboxDb = {
    get: async (key: string) => (await executeForgeTool(appId, "db_get", { key })).output ?? null,
    set: async (key: string, value: unknown) => executeForgeTool(appId, "db_set", { key, value: JSON.stringify(value) }),
    delete: async (key: string) => executeForgeTool(appId, "db_delete", { key }),
    list: async (prefix?: string) => (await executeForgeTool(appId, "db_list", { prefix })).output ?? [],
    insert: async (table: string, data: unknown) => (await executeForgeTool(appId, "table_insert", { table, data: JSON.stringify(data) })).output,
    select: async (table: string, filter?: unknown) =>
      (await executeForgeTool(appId, "table_select", { table, filter: filter ? JSON.stringify(filter) : undefined })).output ?? [],
    update: async (table: string, filter: unknown, data: unknown) =>
      executeForgeTool(appId, "table_update", { table, filter: JSON.stringify(filter), data: JSON.stringify(data) }),
    deleteRows: async (table: string, filter: unknown) => executeForgeTool(appId, "table_delete", { table, filter: JSON.stringify(filter) }),
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      if (logs.length < 50) logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    },
  };

  // Deliberately minimal global surface: no require, process, global, Buffer,
  // setTimeout/setInterval (could be used to dodge the timeout), fetch, or
  // filesystem access of any kind.
  const sandboxGlobals: Record<string, unknown> = {
    req: { method: req.method, route: req.route, query: req.query, body: req.body, user: req.user ?? null },
    db: sandboxDb,
    console: sandboxConsole,
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
  };

  const context = vm.createContext(sandboxGlobals, {
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap the handler body as an async function so the AI can just write plain
  // statements (including `await db.xxx()` and `return {...}`) without extra
  // boilerplate.
  const wrapped = `(async () => { ${file.content}\n })()`;

  const runPromise = (async () => {
    try {
      const script = new vm.Script(wrapped, { filename: "handler.js" });
      const result = await script.runInContext(context, { timeout: SYNC_TIMEOUT_MS });
      if (result && typeof result === "object" && "status" in result) {
        return { status: Number((result as { status: unknown }).status) || 200, body: (result as { body?: unknown }).body ?? null, logs };
      }
      return { status: 200, body: result ?? null, logs };
    } catch (err) {
      return {
        status: 500,
        body: { error: "Handler failed" },
        error: err instanceof Error ? err.message : String(err),
        logs,
      };
    }
  })();

  const timeoutPromise = new Promise<SandboxResult>((resolve) =>
    setTimeout(
      () => resolve({ status: 504, body: { error: "Handler timed out" }, error: "Execution exceeded time limit", logs }),
      WALL_CLOCK_TIMEOUT_MS
    )
  );

  return Promise.race([runPromise, timeoutPromise]);
}
