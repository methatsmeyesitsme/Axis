import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { forgeToolDeclarations, executeForgeTool, truncateSummary } from "./forge-tools";
import { FunctionCallingConfigMode, type FunctionCall } from "@google/genai";

const router: IRouter = Router();

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "forge").map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
    }))
  );
});

router.post("/", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New App" } = req.body as { title?: string };

  if (!userId) {
    // Guest: return a virtual conversation (nothing written to DB)
    res.status(201).json({ id: -1, title, createdAt: new Date().toISOString() });
    return;
  }

  // Enforce the 10-app cap for authenticated users
  const existing = await db.select().from(conversations).where(eq(conversations.userId, userId));
  const forgeCount = existing.filter((c) => c.source === "forge").length;
  if (forgeCount >= 10) {
    res.status(400).json({ error: "You've reached the 10-app limit. Delete an app to make room for a new one." });
    return;
  }

  const [created] = await db
    .insert(conversations)
    .values({ title, language: "General", source: "forge", userId })
    .returning();
  res.status(201).json({ id: created.id, title: created.title, createdAt: created.createdAt });
});

router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({
    id: conv.id, title: conv.title, createdAt: conv.createdAt,
    messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })),
  });
});

router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, createdAt: updated.createdAt });
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })));
});

router.post("/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, guestHistory: rawGuestHistory } = req.body as { content: string; guestHistory?: Array<{role: string; content: string}> };
  const guestHistory: Array<{role: string; content: string}> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;
  const isPersisted = !!userId && id > 0;

  if (isPersisted) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.source !== "forge") { res.status(404).json({ error: "Conversation not found" }); return; }
  }

  const history: Array<{role: string; content: string}> = isPersisted
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (isPersisted) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
  }

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  const systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.

You are Forge, an AI that builds small apps for people, directly in this conversation —
using tools as you go, the same way an agentic coding assistant works. Don't just describe
what you'd do — actually call the tools to do it.

Available tools let you write/delete frontend files (HTML/CSS/JS), store data via simple
key/value storage or real structured tables (create_table + table_insert/select/update/
delete), and define real backend logic with write_backend_handler — JavaScript that
actually runs server-side for a given method+route, with access to \`req\` (method, route,
query, body, user — see accounts below) and \`db\` (get/set/delete/list, insert/select/update/deleteRows), ending with
\`return { status, body }\`. Handler code cannot make outbound network requests and runs
with a short time limit — keep it to request handling and data logic, not long-running work.
Every tool call requires a "summary" argument: a concise, past-tense description of that
single action, 8 words maximum (e.g. "Created login page and styles").

If a tool call fails, its error message is passed back to you. Recover when possible:
retry transient database/connection errors, inspect existing tables before creating them,
and never repeat a completed setup step. A message saying a table, file, or key already
exists is success — continue building with it. Only stop when the app cannot be made
runnable; then give the exact error and one concrete action the user can take.

Never end your turn on a sentence describing what you're about to do next ("I'll now...",
"I will proceed to...") without actually calling that tool in the same response — either
call it immediately or don't mention it yet. A tool reporting something already exists
(e.g. a table) is not an error and needs no explanation to the user; treat it as fine and
keep calling whatever tools are still needed to finish the request in that same turn.

Apps can now be run for real. Once you've written an index.html with write_file, call
run_preview to confirm it's ready, then tell the user to hit the Run button to open it.
Inside the app's own HTML/JS, call any backend handlers you define with
write_backend_handler using a *relative* path prefixed with "api/" — e.g.
fetch("api/todos"), never "/api/todos" or an absolute URL — so requests resolve correctly
inside the preview. Keep asset links and navigation relative too (href="style.css", not
"/style.css"; script src="app.js", not "/app.js").

Accounts are real too: call add_accounts, then use the built-in endpoints api/_auth/signup
and api/_auth/login (POST, body { email, password }) to create or sign in end users — each
returns { user, token }. Store that token in the browser (e.g. localStorage) and send it on
every later request as an "Authorization: Bearer <token>" header, exactly like the api/
prefix used for your own handlers. api/_auth/me (GET) returns the current user or null, and
api/_auth/logout (POST) invalidates the token. Any write_backend_handler code you write
automatically receives the caller as req.user (null if signed out) — no extra wiring needed.

${isPersisted ? "" : "IMPORTANT: this person is not logged in, so anything you build with tools won't be saved. If they ask you to build something, let them know they should log in first so their work persists, before actually calling tools."}`;

  const chatMessages: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: content }] },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let savedContent = "";
  let lastToolError: string | null = null;
  let endedNaturally = false;
  let nudgeCount = 0;
  let forceToolCall = false;

  try {
    // Keep a hard upper bound, but allow a normal app build to finish:
    // several files, tables, handlers, and a final preview check can require
    // more than eight model/tool turns.
    let turnsRemaining = 16;

    while (turnsRemaining-- > 0) {
      const stream = await ai.models.generateContentStream({
        model: "gemini-3.6-flash",
        contents: chatMessages,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: forgeToolDeclarations }],
          ...(forceToolCall
            ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } } }
            : {}),
        },
      });
      forceToolCall = false; // only ever applies to the one turn it was set for

      const turnFunctionCalls: FunctionCall[] = [];
      let turnText = "";

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          turnText += text;
          savedContent += text;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
          }
        }
        const calls = chunk.functionCalls;
        if (calls?.length) turnFunctionCalls.push(...calls);
      }

      if (turnFunctionCalls.length === 0) {
        // Guard against the model describing an action ("I'll now build...")
        // without ever calling the tool for it. A text-only nudge wasn't
        // reliable enough on its own — this now also forces the very next
        // call to emit an actual function call (mode: ANY), so it structurally
        // cannot respond with more narration a second time in a row. Still
        // bounded by turnsRemaining and a nudge cap, so this can't loop forever.
        const soundsUnfinished = /\b(i'll|i will|let me|going to|proceed (to|with))\b/i.test(turnText);
        if (soundsUnfinished && nudgeCount < 3 && turnsRemaining > 0) {
          nudgeCount++;
          forceToolCall = true;
          chatMessages.push({ role: "model", parts: [{ text: turnText }] });
          chatMessages.push({
            role: "user",
            parts: [{
              text:
                nudgeCount === 1
                  ? "You described an action but didn't call any tools for it. Call the necessary tool(s) now to actually do it."
                  : "You're still only describing what you'll do instead of doing it. Stop narrating and call the tool(s) for your very next sentence right now, in this response.",
            }],
          });
          continue;
        }
        endedNaturally = true;
        break; // model produced a final text response, no more tool calls — done
      }

      // Record the model's tool-call turn, then execute each call and stream
      // Working -> summary, then feed the results back for the next turn.
      chatMessages.push({
        role: "model",
        parts: turnFunctionCalls.map((fc) => ({ functionCall: fc })),
      });

      const functionResponseParts: Array<Record<string, unknown>> = [];

      for (let i = 0; i < turnFunctionCalls.length; i++) {
        const call = turnFunctionCalls[i];
        const toolId = `${Date.now()}-${i}`;
        const args = (call.args ?? {}) as Record<string, unknown>;
        const summary = truncateSummary(args.summary, call.name ?? "Working");

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: call.name, summary } })}\n\n`);
        }

        const result = isPersisted
          ? await executeForgeTool(id, call.name ?? "", args)
          : { error: "This person isn't logged in yet, so building can't be saved. Ask them to log in first." };

        if (result.error) {
          lastToolError = result.error;
          req.log.error({ tool: call.name, args, error: result.error }, "[Forge] Tool execution failed");
        }

        savedContent += result.error ? `\n\n✗ ${summary} — ${result.error}` : `\n\n✓ ${summary}`;

        if (!res.writableEnded) {
          if (result.error) {
            res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary, error: result.error } })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary } })}\n\n`);
          }
        }

        functionResponseParts.push({
          functionResponse: {
            name: call.name,
            response: result.error
              ? {
                  error: result.error,
                  recovery:
                    "Recover if possible: retry once, inspect current state, skip any completed step, and continue with the remaining app files.",
                }
              : { output: result.output ?? "ok" },
          },
        });
      }

      chatMessages.push({ role: "user", parts: functionResponseParts });
    }

    if (!endedNaturally && isPersisted) {
      // The model can spend the whole bounded loop on successful setup calls
      // and never get to run_preview. Verify readiness on the server so a
      // completed app is never mislabeled as a failed generation.
      const previewToolId = `${Date.now()}-final-preview`;
      const previewSummary = "Verified app is ready to run";
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolStart: { id: previewToolId, name: "run_preview", summary: previewSummary } })}\n\n`);
      }
      const previewResult = await executeForgeTool(id, "run_preview", {
        summary: previewSummary,
      });
      if (!previewResult.error) {
        endedNaturally = true;
        savedContent += `\n\n✓ ${previewSummary}.`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolDone: { id: previewToolId, summary: previewSummary } })}\n\n`);
        }
      } else {
        lastToolError = previewResult.error;
        req.log.error({ error: previewResult.error }, "[Forge] Final preview check failed");
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ toolError: { id: previewToolId, summary: previewSummary, error: previewResult.error } })}\n\n`);
        }
      }
    }

    if (!endedNaturally) {
      const fallback = lastToolError
        ? `\n\nI couldn't complete the final app readiness check. The completed steps were kept. Last error:\n\n\`${lastToolError}\`\n\nRetry this prompt to continue from the existing files and tables.`
        : "\n\nThe app build reached its safety limit before the final readiness check. The completed files and tables were kept. Retry this prompt to continue from the existing app.";
      savedContent += fallback;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
      }
    }

    if (isPersisted && savedContent) {
      try {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      } catch (saveErr) {
        // Generation succeeded even if the history write is temporarily
        // unavailable. Do not turn a finished app build into a failed stream.
        req.log.error({ saveErr }, "[Forge] Could not save assistant message");
      }
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "[Forge] Gemini error");
    if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : String(err);
      const recovery = "The request stopped before completion. Retry this prompt; completed files and tables were kept, so Forge will skip them and continue.";
      res.write(`data: ${JSON.stringify({ error: `${message}. ${recovery}` })}\n\n`);
      res.end();
    }
  }
});

export default router;
