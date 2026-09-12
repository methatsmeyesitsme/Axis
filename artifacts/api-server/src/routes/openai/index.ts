import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
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
import { friendlyGeminiErrorMessage } from "../../lib/gemini-errors";
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
  if (name === "github_list_files") {
    words = path ? ["Listing", shortPath, "files"] : ["Listing", "repo", "files"];
  } else if (name === "github_read_file") {
    words = shortPath ? ["Reading", shortPath] : ["Reading", "file"];
  } else if (name === "github_write_file") {
    if (shortPath) words = phase === "done" ? ["Saved", shortPath] : ["Editing", shortPath];
    else words = phase === "done" ? ["Saved", "file"] : ["Writing", "file"];
  } else if (name === "web_search") {
    words = phase === "done" ? ["Finished", "web", "search"] : ["Searching", "the", "web"];
  } else if (name === "image_gen") {
    words = phase === "done" ? ["Image", "ready"] : ["Drawing", "your", "image"];
  } else {
    const label = name.replace(/^github_/, "").replace(/_/g, " ");
    words = phase === "done" ? ["Done", label] : ["Using", label];
  }
  if (phase === "error") words = ["Failed", ...words.slice(0, 4)];
  return words.filter(Boolean).slice(0, 5).join(" ");
}

const router: IRouter = Router();

const MIME_MAP: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
  yaml: "application/yaml",
  yml: "application/yaml",
  tsv: "text/tab-separated-values",
};

function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? "text/plain";
}

function extractImageParts(content: string): {
  text: string;
  imageParts: Array<{ inlineData: { mimeType: string; data: string } }>;
} {
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  const text = content
    .replace(/\[IMAGE:([^|]+)\|([^\]]+)\]/g, (_, mimeType: string, b64: string) => {
      imageParts.push({ inlineData: { mimeType: mimeType.trim(), data: b64.trim() } });
      return "";
    })
    .trim();
  return { text, imageParts };
}

async function loadMemories(userId: number): Promise<string> {
  const rows = await db.select().from(userMemories).where(eq(userMemories.userId, userId)).orderBy(desc(userMemories.createdAt)).limit(30);
  if (rows.length === 0) return "";
  return rows.map((r) => r.content).join("\n");
}

async function extractAndSaveMemories(userId: number, userMessage: string): Promise<void> {
  try {
    const prompt = `Extract personal facts about the user from this message. Only extract clear, first-person facts (name, age, job, location, preferences, etc.). If there are no personal facts, reply with exactly: NONE\n\nMessage: "${userMessage.slice(0, 500)}"\n\nReply with one fact per line, or NONE.`;
    const text = getAiProvider() === "local"
      ? (await localGenerate([
          { role: "system", content: "You extract memory facts. Reply with facts or exactly NONE." },
          { role: "user", content: prompt },
        ], { maxNewTokens: 80, maxMessages: 2, maxCharsPerMessage: 800, fast: true })).trim()
      : (await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 100 },
        })).text?.trim() ?? "";
    if (!text || text === "NONE") return;
    const facts = text.split("\n").map((f) => f.trim()).filter((f) => f && f !== "NONE");
    for (const fact of facts) await db.insert(userMemories).values({ userId, content: fact });
  } catch { /* best-effort */ }
}

async function generateTitle(userMessage: string, log?: { error: (o: unknown, m: string) => void }): Promise<string> {
  try {
    const prompt = `Create a short title (2-5 words) for a chat starting with this message. Title Case only. Reply with ONLY the title.\n\nMessage: "${userMessage.slice(0, 400)}"`;
    const raw = getAiProvider() === "local"
      ? (await localGenerate([
          { role: "system", content: "Reply with only a short chat title." },
          { role: "user", content: prompt },
        ], { maxNewTokens: 24, maxMessages: 2, maxCharsPerMessage: 500, fast: true })).trim()
      : (await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 50, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
        })).text?.trim() ?? "";
    const candidate = raw.replace(/^["']|["'.,!?]$/g, "").trim();
    if (candidate && candidate.length > 1 && candidate.length < 80) return candidate;
  } catch (e) {
    log?.error({ err: e }, "[Axis] generateTitle: exception");
  }
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
  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  let systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.\n\nYou are Axis, an expert AI programming assistant specializing in ${convLanguage}.\n\nBe clear, accurate, and practical.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}\n\nWhen debugging: identify issues, explain why, show fixed code.\nWhen generating code: production-quality, markdown fences with language tags.\n`;
  if (planMode) systemPrompt += `\n\nPLAN MODE: help plan only, use pseudocode, end with a question.`;

  if (getAiProvider() === "local") {
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
        planMode ? "PLAN MODE: help plan only, use pseudocode, end with a question." : "",
        "You can generate images when the user asks to draw or create a picture.",
        "Never refuse normal coding or GitHub/repository questions.",
      ].filter(Boolean).join("\n\n");

      const short = isShortRequest(content);
      const greeting = isGreeting(content);
      const historySlice = greeting || short ? history.slice(-2) : history.slice(-4);
      const localMessages: LocalChatMessage[] = [
        { role: "system", content: localSystem },
        ...historySlice.map((m): LocalChatMessage => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content.replace(/\[IMAGE:[^\]]*\]/g, "[image]").replace(/\[FILEDATA:[^\]]*\]/g, "[file]").slice(0, greeting ? 300 : short ? 500 : 1200),
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
          const savedContent = `${reply}\n\n[IMAGE:${mimeType}|${b64}]`;
          if (history.length === 0 && userId && id > 0) {
            const newTitle = await generateTitle(content, req.log);
            await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
            if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
          }
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          if (userId && id > 0) await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: "Image failed", error: message } })}\n\n`);
            res.write(`data: ${JSON.stringify({ imageFailed: true })}\n\n`);
          }
          workingMessages.push({ role: "user", content: `Image generation failed: ${message}. Apologize briefly.` });
        }
      }

      const wantsGithubTool =
        /\b(github|my repo|the repo|repository|pull request|\bPR\b|commit to|list files|read file|write file|pull from|clone|what is this repo|tell me what it is)\b/i.test(content) ||
        /\b[\w.-]+\/[\w.-]+\b/.test(content);
      const wantsWebSearch = /\b(search the web|look up online|current price|latest news|weather today)\b/i.test(content);
      const localTools = [...(wantsGithubTool ? toLocalToolDefinitions(githubToolDeclarations) : [])];

      if (wantsWebSearch) {
        const toolId = `${Date.now()}-web-search`;
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "web_search", summary: toolStatusSummary("web_search", {}, "start") } })}\n\n`);
        try {
          const search = await localWebSearch(content);
          for (const source of search.sources) sources.push({ url: source.url, title: source.title });
          workingMessages.push({ role: "user", content: ["Live web search results:", JSON.stringify(search.sources).slice(0, 2000)].join("\n") });
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolDone: { id: toolId, summary: toolStatusSummary("web_search", {}, "done") } })}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          workingMessages.push({ role: "user", content: `Web search failed: ${message}` });
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolError: { id: toolId, summary: toolStatusSummary("web_search", {}, "error"), error: message } })}\n\n`);
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
        for (let turn = 0; turn < 3; turn++) {
          const decision = await localAgentTurn(workingMessages, localTools, { maxNewTokens: 350 });
          if (decision.kind === "final") { reply = decision.content; break; }
          const toolId = `${Date.now()}-${turn}`;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: decision.name, summary: toolStatusSummary(decision.name, decision.arguments, "start") } })}\n\n`);
          let result: { output?: unknown; error?: string };
          if (userId && (await isGithubReady(userId))) result = await executeGithubTool(userId, decision.name, decision.arguments);
          else result = { error: "No GitHub repository is connected/selected. Connect GitHub in Settings and select a repo, then try again." };
          if (!res.writableEnded) {
            const summary = toolStatusSummary(decision.name, decision.arguments, result.error ? "error" : "done");
            res.write(`data: ${JSON.stringify(result.error ? { toolError: { id: toolId, summary, error: result.error } } : { toolDone: { id: toolId, summary } })}\n\n`);
          }
          workingMessages.push({ role: "assistant", content: JSON.stringify({ action: "tool", name: decision.name, arguments: decision.arguments }) });
          workingMessages.push({ role: "user", content: buildLocalToolResultMessage(decision.name, result) });
        }
        if (!reply) {
          reply = await localGenerateStreaming(workingMessages, {
            maxNewTokens: 500, maxMessages: 6, maxCharsPerMessage: 1200,
            onToken: (chunk) => { if (!res.writableEnded && chunk) res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`); },
          });
        } else if (!res.writableEnded) {
          for (let i = 0; i < reply.length; i += 8) {
            res.write(`data: ${JSON.stringify({ content: reply.slice(i, i + 8) })}\n\n`);
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      }

      const fileBlockRe = /\[FILE:\s*([^\]\n]+)\]\s*\n```[\w-]*\n([\s\S]*?)```/gi;
      let savedContent = reply.replace(fileBlockRe, (_, rawName: string, fileContent: string) => {
        const filename = rawName.trim();
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeType = getMimeType(ext);
        const b64 = Buffer.from(fileContent).toString("base64");
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ fileData: { filename, b64, mimeType } })}\n\n`);
        return `[FILEDATA: ${filename}|${mimeType}|${b64}]`;
      });

      if (sources.length > 0 && !res.writableEnded) res.write(`data: ${JSON.stringify({ sources })}\n\n`);

      if (history.length === 0 && userId && id > 0) {
        const newTitle = await generateTitle(content, req.log);
        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
      }

      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      if (userId && id > 0) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent || reply });
        void extractAndSaveMemories(userId, content);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ error: "Cloud AI provider is not configured. Set AXIS_AI_PROVIDER=local." })}\n\n`);
    res.end();
  }
});

export default router;
