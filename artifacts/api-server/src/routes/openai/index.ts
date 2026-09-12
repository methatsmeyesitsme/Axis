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
import { toolStatusSummary } from "../../lib/status-line";

void preloadLocalModel();

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
    const all = await db.select().from(userMemories).where(eq(userMemories.userId, userId)).orderBy(desc(userMemories.createdAt));
    if (all.length > 30) {
      for (const id of all.slice(30).map((r) => r.id)) await db.delete(userMemories).where(eq(userMemories.id, id));
    }
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
          workingMessages.push({ role: "user", content: `Image generation failed: ${message}. Apologize briefly and offer to try a simpler prompt.` });
        }
      }

      const wantsGithubTool = /\b(github|my repo|the repo|repository|pull request|\bPR\b|commit to|list files in|read file from|write file to)\b/i.test(content);
      const wantsWebSearch = /\b(search the web|look up online|current price|latest news|weather today)\b/i.test(content);
      const localTools = [...(wantsGithubTool ? toLocalToolDefinitions(githubToolDeclarations) : [])];

      if (wantsWebSearch) {
        const toolId = `${Date.now()}-web-search`;
        const webStart = toolStatusSummary("web_search", {}, "start");
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: "web_search", summary: webStart } })}\n\n`);
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
          const startSummary = toolStatusSummary(decision.name, decision.arguments, "start");
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ toolStart: { id: toolId, name: decision.name, summary: startSummary } })}\n\n`);
          let result: { output?: unknown; error?: string };
          if (userId && (await isGithubReady(userId))) result = await executeGithubTool(userId, decision.name, decision.arguments);
          else result = { error: "No GitHub repository is connected/selected. Connect GitHub and pick a repo in Settings." };
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
      if (history.length === 0 && userId && id > 0 && !greeting) {
        const newTitle = await generateTitle(content, req.log);
        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
      }
      if (userId && !greeting) extractAndSaveMemories(userId, content).catch(() => {});
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      if (userId && id > 0 && savedContent) await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
    } catch (err) {
      const msg = friendlyGeminiErrorMessage(err, "Local model failed to generate a response");
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  const { text: currentText, imageParts: currentImageParts } = extractImageParts(content);
  const chatMessages: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [
    ...history.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content.replace(/\[IMAGE:[^\]]*\]/g, "[image was attached here]").replace(/\[FILEDATA:[^\]]*\]/g, "[file was generated here]") }],
    })),
    { role: "user" as const, parts: [...currentImageParts, { text: currentText || "Please look at the attached image." }] },
  ];

  if (userId && (await isGithubReady(userId))) {
    let toolRounds = 4;
    while (toolRounds-- > 0) {
      const toolCheck = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: chatMessages,
        config: {
          systemInstruction: `${systemPrompt}\n\nIf asking about the connected GitHub repo, use github_* tools. Otherwise answer normally.`,
          tools: [{ functionDeclarations: githubToolDeclarations }],
        },
      });
      const calls = toolCheck.functionCalls;
      if (!calls?.length) break;
      chatMessages.push({ role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
      const responseParts: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const result = await executeGithubTool(userId, call.name ?? "", args);
        responseParts.push({ functionResponse: { name: call.name, response: result.error ? { error: result.error } : { output: result.output ?? "ok" } } });
      }
      chatMessages.push({ role: "user", parts: responseParts });
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let fullResponse = "";
  try {
    const stream = await ai.models.generateContentStream({
      model: "gemini-3.6-flash",
      contents: chatMessages,
      config: { maxOutputTokens: 8192, systemInstruction: systemPrompt, tools: [{ googleSearch: {} }] },
    });
    let lastGroundingChunks: Array<{ web?: { uri: string; title?: string } }> = [];
    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
      const meta = (chunk as unknown as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title?: string } }> } }> }).candidates?.[0]?.groundingMetadata;
      if (meta?.groundingChunks?.length) lastGroundingChunks = meta.groundingChunks;
    }
    if (!res.writableEnded) {
      let savedContent = fullResponse;
      const sources = lastGroundingChunks.filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri, title: c.web!.title ?? c.web!.uri }));
      if (sources.length > 0) res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      if (userId && id > 0 && savedContent) await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
  } catch (err) {
    const msg = friendlyGeminiErrorMessage(err);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
