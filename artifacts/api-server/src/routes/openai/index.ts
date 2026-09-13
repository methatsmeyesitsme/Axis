import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import {
  localGenerate,
  localGenerateStreaming,
  localAgentTurn,
  buildLocalToolResultMessage,
  buildLocalSystemPrompt,
  isShortRequest,
  isGreeting,
  preloadLocalModel,
  localWebSearch,
  toLocalToolDefinitions,
  wantsImageGeneration,
  extractImagePrompt,
  localGenerateImage,
  type LocalChatMessage,
} from "@workspace/integrations-local-ai";
import { eq, desc, isNull } from "drizzle-orm";
import { githubToolDeclarations, executeGithubTool, isGithubReady } from "../github-tools";
import { getAiProvider } from "../../lib/ai-provider";

void preloadLocalModel();

function toolStatusSummary(
  name: string,
  args: Record<string, unknown> = {},
  phase: "start" | "done" | "error" = "start",
): string {
  const path = String(args.path ?? args.file ?? args.filename ?? "").replace(/^\/+/, "");
  const shortPath = path ? path.split("/").pop() || path : "";
  let words: string[] = ["Working"];
  if (name === "github_list_files") words = path ? ["Listing", shortPath, "files"] : ["Listing", "repo", "files"];
  else if (name === "github_read_file") words = shortPath ? ["Reading", shortPath] : ["Reading", "file"];
  else if (name === "github_write_file") words = shortPath ? (phase === "done" ? ["Saved", shortPath] : ["Editing", shortPath]) : ["Writing", "file"];
  else if (name === "web_search") words = phase === "done" ? ["Finished", "web", "search"] : ["Searching", "the", "web"];
  else if (name === "image_gen") words = phase === "done" ? ["Image", "ready"] : ["Drawing", "your", "image"];
  else {
    const label = name.replace(/^github_/, "").replace(/_/g, " ");
    words = phase === "done" ? ["Done", label] : ["Using", label];
  }
  if (phase === "error") words = ["Failed", ...words.slice(0, 4)];
  return words.filter(Boolean).slice(0, 5).join(" ");
}

const router: IRouter = Router();

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    csv: "text/csv", txt: "text/plain", json: "application/json", html: "text/html", md: "text/markdown",
  };
  return map[ext.toLowerCase()] ?? "text/plain";
}

async function loadMemories(userId: number): Promise<string> {
  const rows = await db.select().from(userMemories).where(eq(userMemories.userId, userId)).orderBy(desc(userMemories.createdAt)).limit(30);
  if (rows.length === 0) return "";
  return rows.map((r) => r.content).join("\n");
}

async function generateTitle(userMessage: string): Promise<string> {
  try {
    const raw = (await localGenerate(
      [
        { role: "system", content: "Reply with only a short chat title." },
        { role: "user", content: `Title (2-5 words) for: "${userMessage.slice(0, 300)}"` },
      ],
      { maxNewTokens: 24, maxMessages: 2, maxCharsPerMessage: 400, fast: true },
    )).trim();
    const candidate = raw.replace(/^["']|["'.,!?]$/g, "").trim();
    if (candidate && candidate.length > 1 && candidate.length < 80) return candidate;
  } catch { /* ignore */ }
  return "New Chat";
}

router.get("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db.select().from(conversations).where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId)).orderBy(desc(conversations.createdAt));
  res.json(result.filter((c) => c.source === "axis").map((c) => ({ id: c.id, title: c.title, language: c.language, createdAt: c.createdAt })));
});

router.post("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New Chat", language = "TypeScript" } = req.body as { title?: string; language?: string };
  if (!userId) {
    res.status(201).json({ id: -1, title, language, createdAt: new Date().toISOString() });
    return;
  }
  const [created] = await db.insert(conversations).values({ title, language, source: "axis", userId }).returning();
  res.status(201).json({ id: created.id, title: created.title, language: created.language, createdAt: created.createdAt });
});

router.get("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({ id: conv.id, title: conv.title, language: conv.language, createdAt: conv.createdAt, messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })) });
});

router.patch("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { title } = req.body as { title: string };
  if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const [updated] = await db.update(conversations).set({ title: title.trim() }).where(eq(conversations.id, id)).returning();
  res.json({ id: updated.id, title: updated.title, language: updated.language, createdAt: updated.createdAt });
});

router.delete("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })));
});

router.post("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const { content, planMode = false, language: bodyLanguage, guestHistory: rawGuestHistory } = req.body as {
    content: string; planMode?: boolean; language?: string; guestHistory?: Array<{ role: string; content: string }>;
  };
  const guestHistory = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;

  let convLanguage = bodyLanguage ?? "TypeScript";
  if (userId && id > 0) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    convLanguage = conv.language;
  }

  const history: Array<{ role: string; content: string }> = (userId && id > 0)
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  if (userId && id > 0) await db.insert(messages).values({ conversationId: id, role: "user", content });

  const memoryBlock = userId ? await loadMemories(userId) : "";

  if (getAiProvider() !== "local") {
    res.status(500).json({ error: "Set AXIS_AI_PROVIDER=local" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ status: "thinking", summary: "Thinking it through" })}\n\n`);

    const localSystem = [
      buildLocalSystemPrompt(convLanguage),
      memoryBlock ? `Known about this user:\n${memoryBlock.slice(0, 400)}` : "",
      planMode ? "PLAN MODE: help plan only." : "",
      "Never refuse normal coding or GitHub questions.",
    ].filter(Boolean).join("\n\n");

    const short = isShortRequest(content);
    const greeting = isGreeting(content);
    const historySlice = greeting || short ? history.slice(-2) : history.slice(-4);
    const localMessages: LocalChatMessage[] = [
      { role: "system", content: localSystem },
      ...historySlice.map((m): LocalChatMessage => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content.replace(/\[IMAGE:[^\]]*\]/g, "[image]").slice(0, greeting ? 300 : short ? 500 : 1200),
      })),
      { role: "user", content: content.slice(0, greeting ? 200 : short ? 800 : 1600) },
    ];
    const workingMessages = [...localMessages];
    let reply = "";
    const sources: Array<{ url: string; title: string }> = [];

    if (wantsImageGeneration(content)) {
      const toolId = `${Date.now()}-image`;
      const imgPrompt = extractImagePrompt(content);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "image_gen", summary: "Drawing your image" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ generatingImage: true })}\n\n`);
      }
      try {
        const { b64, mimeType } = await localGenerateImage(imgPrompt);
        reply = `Here's an image for: ${imgPrompt}`;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
          res.write(`data: ${JSON.stringify({ imageData: { b64, mimeType } })}\n\n`);
          res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: "Image ready" } })}\n\n`);
        }
        if (userId && id > 0) await db.insert(messages).values({ conversationId: id, role: "assistant", content: `${reply}\n\n[IMAGE:${mimeType}|${b64}]` });
        if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Image failed", error: message } })}\n\n`);
      }
    }

    const wantsGithubTool =
      /\b(github|my repo|the repo|repository|pull request|\bPR\b|commit to|list files|read file|write file|pull from|clone|what is this repo|tell me what it is)\b/i.test(content) ||
      /\b[\w.-]+\/[\w.-]+\b/.test(content);
    const wantsWebSearch = /\b(search the web|look up online|current price|latest news|weather today)\b/i.test(content);
    const localTools = [...(wantsGithubTool ? toLocalToolDefinitions(githubToolDeclarations) : [])];

    if (wantsWebSearch) {
      const toolId = `${Date.now()}-web`;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "web_search", summary: "Searching the web" } })}\n\n`);
      try {
        const search = await localWebSearch(content);
        for (const s of search.sources) sources.push({ url: s.url, title: s.title });
        workingMessages.push({ role: "user", content: `Live web search results:\n${JSON.stringify(search.sources).slice(0, 2000)}` });
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: "Finished web search" } })}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Search failed", error: message } })}\n\n`);
      }
    }

    if (localTools.length === 0) {
      reply = await localGenerateStreaming(workingMessages, {
        fast: short || greeting,
        maxNewTokens: greeting ? 48 : short ? 96 : 900,
        maxMessages: greeting ? 2 : short ? 3 : 6,
        maxCharsPerMessage: greeting ? 300 : short ? 600 : 1400,
        onToken: (chunk) => { if (!res.writableEnded && chunk) res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`); },
      });
    } else {
      if (userId && (await isGithubReady(userId))) {
        const listId = `${Date.now()}-list`;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: listId, name: "github_list_files", summary: "Listing repo files" } })}\n\n`);
        const listed = await executeGithubTool(userId, "github_list_files", { path: "" });
        if (!res.writableEnded) {
          const summary = toolStatusSummary("github_list_files", {}, listed.error ? "error" : "done");
          res.write(`data: ${JSON.stringify(listed.error ? { toolError: { id: listId, summary, error: listed.error } } : { toolDone: { id: listId, summary } })}\n\n`);
        }
        workingMessages.push({ role: "user", content: buildLocalToolResultMessage("github_list_files", listed) });

        const items = Array.isArray(listed.output) ? (listed.output as Array<{ path?: string; name?: string; type?: string }>) : [];
        const readme = items.find((i) => /readme/i.test(String(i.path ?? i.name ?? "")) && i.type !== "dir");
        if (readme?.path) {
          const readId = `${Date.now()}-readme`;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: readId, name: "github_read_file", summary: "Reading README" } })}\n\n`);
          const read = await executeGithubTool(userId, "github_read_file", { path: readme.path });
          if (!res.writableEnded) {
            const summary = toolStatusSummary("github_read_file", { path: readme.path }, read.error ? "error" : "done");
            res.write(`data: ${JSON.stringify(read.error ? { toolError: { id: readId, summary, error: read.error } } : { toolDone: { id: readId, summary } })}\n\n`);
          }
          workingMessages.push({ role: "user", content: buildLocalToolResultMessage("github_read_file", read) });
        }

        workingMessages.push({
          role: "user",
          content: "Using the tool results above, explain what this repository is in plain language. Do not output tool names or JSON.",
        });
      } else if (!userId) {
        workingMessages.push({ role: "user", content: "User is not logged in. Tell them to log in and connect GitHub in Settings." });
      } else {
        workingMessages.push({ role: "user", content: "No GitHub repo connected. Tell them to connect GitHub and select a repo in Settings." });
      }

      reply = await localGenerateStreaming(workingMessages, {
        maxNewTokens: 500, maxMessages: 8, maxCharsPerMessage: 1400,
        onToken: (chunk) => { if (!res.writableEnded && chunk) res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`); },
      });
      if (/^github_[\w]+$/.test(reply.trim()) || (reply.trim().startsWith("{") && reply.includes("summary"))) {
        reply = "I pulled the file list from your connected GitHub repo. Ask me about a specific file or what the project does.";
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
      }
    }

    if (sources.length > 0 && !res.writableEnded) res.write(`data: ${JSON.stringify({ sources })}\n\n`);

    if (history.length === 0 && userId && id > 0) {
      const newTitle = await generateTitle(content);
      await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
    }

    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    if (userId && id > 0 && reply) {
      await db.insert(messages).values({ conversationId: id, role: "assistant", content: reply });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
