import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { forgeToolDeclarations, executeForgeTool, truncateSummary } from "./forge-tools";
import type { FunctionCall } from "@google/genai";

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
query, body) and \`db\` (get/set/delete/list, insert/select/update/deleteRows), ending with
\`return { status, body }\`. Handler code cannot make outbound network requests and runs
with a short time limit — keep it to request handling and data logic, not long-running work.
Every tool call requires a "summary" argument: a concise, past-tense description of that
single action, 8 words maximum (e.g. "Created login page and styles").

One tool — run_preview — exists in the tool list but isn't functional yet; if you call it
(or if asked about running/previewing the app), be upfront that's coming in a future update,
while everything else (files, storage, tables, and now real backend logic) works for real
right now. Accounts (add_accounts) aren't available yet either — same caveat applies.

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

  try {
    let turnsRemaining = 8; // guard against runaway tool loops

    while (turnsRemaining-- > 0) {
      const stream = await ai.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: chatMessages,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: forgeToolDeclarations }],
        },
      });

      const turnFunctionCalls: FunctionCall[] = [];

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          savedContent += text;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
          }
        }
        const calls = chunk.functionCalls;
        if (calls?.length) turnFunctionCalls.push(...calls);
      }

      if (turnFunctionCalls.length === 0) {
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

        if (!res.writableEnded) {
          if (result.error) {
            res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary, error: result.error } })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary } })}\n\n`);
          }
        }

        functionResponseParts.push({
          functionResponse: { name: call.name, response: result.error ? { error: result.error } : { output: result.output ?? "ok" } },
        });
      }

      chatMessages.push({ role: "user", parts: functionResponseParts });
    }

    if (isPersisted && savedContent) {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "[Forge] Gemini error");
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
