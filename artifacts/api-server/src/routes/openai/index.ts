import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
import { eq, desc, isNull } from "drizzle-orm";

const router: IRouter = Router();

// ── MIME map ─────────────────────────────────────────────────────────────────

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

// Pulls any [IMAGE:mimeType|base64] markers out of a user message so they can be
// sent to Gemini as real inlineData parts (i.e. the model can actually see them),
// rather than as a giant base64 text blob.
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

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadMemories(userId: number): Promise<string> {
  const rows = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt))
    .limit(30);
  if (rows.length === 0) return "";
  return rows.map((r) => r.content).join("\n");
}

async function extractAndSaveMemories(userId: number, userMessage: string): Promise<void> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [{
          text: `Extract personal facts about the user from this message. Only extract clear, first-person facts (name, age, job, location, preferences, etc.). If there are no personal facts, reply with exactly: NONE\n\nMessage: "${userMessage.slice(0, 500)}"\n\nReply with one fact per line, or NONE.`,
        }],
      }],
      config: { maxOutputTokens: 100 },
    });
    const text = response.text?.trim() ?? "";
    if (!text || text === "NONE") return;
    const facts = text.split("\n").map((f) => f.trim()).filter((f) => f && f !== "NONE");
    for (const fact of facts) {
      await db.insert(userMemories).values({ userId, content: fact });
    }
    const all = await db
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(desc(userMemories.createdAt));
    if (all.length > 30) {
      const toDelete = all.slice(30).map((r) => r.id);
      for (const id of toDelete) {
        await db.delete(userMemories).where(eq(userMemories.id, id));
      }
    }
  } catch {
    // Memory extraction is best-effort
  }
}

async function generateTitle(userMessage: string, log?: { error: (o: unknown, m: string) => void }): Promise<string> {
  try {
    const titleResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [{
          text: `Create a short, specific title (2-5 words) for a chat that starts with this message. Rules: be specific about the actual topic (e.g. "React useState Hook Bug", "Python CSV Parser", "Sort Algorithm Comparison"), use Title Case, no quotes, no punctuation at the end. Reply with ONLY the title.\n\nMessage: "${userMessage.slice(0, 500)}"`,
        }],
      }],
      config: {
        maxOutputTokens: 50,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const raw = titleResponse.text?.trim() ?? "";
    const candidate = raw.replace(/^["']|["'.,!?]$/g, "").trim();
    if (candidate && candidate.length > 1 && candidate.length < 80) return candidate;
    log?.error({ raw, candidate }, "[Axis] generateTitle: candidate rejected");
  } catch (e) {
    log?.error({ err: e }, "[Axis] generateTitle: exception");
  }
  return "New Chat";
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const result = await db
    .select()
    .from(conversations)
    .where(userId ? eq(conversations.userId, userId) : isNull(conversations.userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.filter((c) => c.source === "axis").map((c) => ({
      id: c.id,
      title: c.title,
      language: c.language,
      createdAt: c.createdAt,
    }))
  );
});

router.post("/conversations", async (req, res) => {
  const userId = req.session?.userId ?? null;
  const { title = "New Chat", language = "TypeScript" } = req.body as { title?: string; language?: string };
  if (!userId) {
    // Guest: return a virtual conversation (nothing written to DB)
    res.status(201).json({ id: -1, title, language, createdAt: new Date().toISOString() });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title, language, source: "axis", userId })
    .returning();
  res.status(201).json({
    id: created.id,
    title: created.title,
    language: created.language,
    createdAt: created.createdAt,
  });
});

router.get("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json({
    id: conv.id, title: conv.title, language: conv.language, createdAt: conv.createdAt,
    messages: msgs.map((m) => ({ id: m.id, conversationId: m.conversationId, role: m.role, content: m.content, createdAt: m.createdAt })),
  });
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
  const { content, planMode = false, language: bodyLanguage, guestHistory: rawGuestHistory } = req.body as { content: string; planMode?: boolean; language?: string; guestHistory?: Array<{role: string; content: string}> };
  const guestHistory: Array<{role: string; content: string}> = rawGuestHistory ?? [];
  const userId = req.session?.userId ?? null;

  // Resolve language: authenticated users load from DB; guests supply via body
  let convLanguage = bodyLanguage ?? "TypeScript";
  if (userId && id > 0) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
    convLanguage = conv.language;
  }

  // History: DB for authenticated users, in-body for guests
  const history: Array<{role: string; content: string}> = (userId && id > 0)
    ? (await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt)).map((m) => ({ role: m.role, content: m.content }))
    : guestHistory;

  // Only persist user message for authenticated users
  if (userId && id > 0) {
    await db.insert(messages).values({ conversationId: id, role: "user", content });
  }

  const memoryBlock = userId ? await loadMemories(userId) : "";

  const nowUtc = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const timeUtc = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: true });

  let systemPrompt = `Today is ${nowUtc}, ${timeUtc} UTC.

You are Axis, an expert AI programming assistant created by CodeGen, specializing in ${convLanguage}.

CORE IDENTITY:
- You are Axis — brilliant, precise, and friendly. You make complex code feel approachable.
- You specialize in ${convLanguage} but are fluent in all major programming languages.
- You think like a senior engineer and teach like a great mentor.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}

CORE BEHAVIOR:
1. When a user shares or pastes code WITHOUT a specific request:
   - Describe what the code does at a high level first
   - Walk through the key parts with clear, accessible explanations
   - Point out any issues, inefficiencies, or improvements you notice

2. When a user asks to FIX or DEBUG code:
   - Step 1: Identify ALL bugs/issues clearly and specifically
   - Step 2: Explain WHY each is a problem in plain language
   - Step 3: Show the corrected, fully-working code
   - Step 4: Briefly explain what changed and why

3. When GENERATING new code:
   - Write production-quality, clean, well-commented ${convLanguage} code
   - Follow best practices and idioms for ${convLanguage}
   - Include error handling where appropriate
   - After the code, explain how it works and key design decisions

4. Always format code in markdown code blocks with the correct language tag.

5. Communication style: Clear and beginner-friendly, use **bold** for key terms, numbered lists for steps.

6. If the user's message contains "[POSSIBLE SYNTAX ISSUES DETECTED]", acknowledge and fix those issues.

7. Always offer a follow-up: suggest what to build next or ask if they want a deeper explanation.

WEB SEARCH: You have access to real-time Google Search. Use it automatically for current prices, news, recent events, product info, or any question requiring up-to-date data. Always include the source URL when citing search results.

IMAGE GENERATION: When the user asks you to generate, create, draw, make, or show an image, picture, illustration, photo, or artwork, include this tag on its own line:
[IMAGE_PROMPT: a detailed visual description of the image]
The image will be generated automatically. Do not use ASCII art.
IMPORTANT: this tag MUST be the very last thing in your entire response — everything after it is discarded. If you also need to write text or generate a file in the same response, write the text and the [FILE: ...] block FIRST, and put [IMAGE_PROMPT: ...] last, after them.

FILE GENERATION: When the user asks for a downloadable file (CSV, spreadsheet, text file, data file, etc.), use this exact format — the marker on one line, then immediately the code block:
[FILE: filename.ext]
\`\`\`ext
file content here
\`\`\`
Use the correct file extension (.csv for spreadsheets, .txt for text, .json for JSON, etc.). The user will get a direct download button — do NOT show just a plain code block for file requests.

COMBINING ACTIONS: You are not limited to one action per response. If a request calls for it, a single response can include written text, a generated file, AND a generated image together — write your explanation, then any [FILE: ...] block(s), and finish with [IMAGE_PROMPT: ...] last (per the ordering rule above).`;

  if (planMode) {
    systemPrompt += `\n\nPLAN MODE IS ACTIVE — Help the user plan, not implement. Use pseudocode only. End with a question that moves planning forward.`;
  }

  // Strip huge embedded data from history so Gemini context stays manageable
  const { text: currentText, imageParts: currentImageParts } = extractImageParts(content);
  const chatMessages = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : ("user" as "model" | "user"),
      parts: [{
        text: m.content
          .replace(/\[IMAGE:[^\]]*\]/g, "[image was attached here]")
          .replace(/\[FILEDATA:[^\]]*\]/g, "[file was generated here]"),
      }],
    })),
    {
      role: "user" as const,
      parts: [
        ...currentImageParts,
        { text: currentText || "Please look at the attached image." },
      ],
    },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let fullResponse = "";

  try {
    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: chatMessages,
      config: {
        maxOutputTokens: 8192,
        systemInstruction: systemPrompt,
        tools: [{ googleSearch: {} }],
      },
    });

    let lastGroundingChunks: Array<{ web?: { uri: string; title?: string } }> = [];
    let generatingImageNotified = false;

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        // Notify client as soon as [IMAGE_PROMPT appears — long before image gen starts
        if (!generatingImageNotified && fullResponse.search(/\[IMAGE_PROMPT/i) >= 0) {
          generatingImageNotified = true;
          res.write(`data: ${JSON.stringify({ generatingImage: true })}\n\n`);
        }
      }
      const meta = (chunk as unknown as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri: string; title?: string } }> } }> })
        .candidates?.[0]?.groundingMetadata;
      if (meta?.groundingChunks?.length) lastGroundingChunks = meta.groundingChunks;
    }

    if (!res.writableEnded) {
      // ── 1. Strip [IMAGE_PROMPT:...] from displayed text ───────────────────
      // Use string search so we don't require a closing ']' (model sometimes omits it)
      const imagePromptStart = fullResponse.search(/\[IMAGE_PROMPT/i);
      const hasImagePrompt = imagePromptStart >= 0;
      let savedContent = hasImagePrompt
        ? fullResponse.slice(0, imagePromptStart).trimEnd()
        : fullResponse;
      // Extract the prompt text (with or without closing bracket)
      const imagePromptText = hasImagePrompt
        ? (fullResponse.slice(imagePromptStart).match(/\[IMAGE_PROMPT:\s*([\s\S]+?)(?:\]|$)/i)?.[1]?.trim() ?? null)
        : null;

      // ── 2. Process [FILE: filename.ext] + code block → fileData events ────
      const fileBlockRe = /\[FILE:\s*([^\]\n]+)\]\s*\n```[\w-]*\n([\s\S]*?)```/gi;
      savedContent = savedContent.replace(fileBlockRe, (_, rawName: string, fileContent: string) => {
        const filename = rawName.trim();
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeType = getMimeType(ext);
        const b64 = Buffer.from(fileContent).toString("base64");
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ fileData: { filename, b64, mimeType } })}\n\n`);
        }
        return `[FILEDATA: ${filename}|${mimeType}|${b64}]`;
      });

      // ── 3. Send grounding sources ─────────────────────────────────────────
      const sources = lastGroundingChunks
        .filter((c) => c.web?.uri)
        .map((c) => ({ url: c.web!.uri, title: c.web!.title ?? c.web!.uri }));
      if (sources.length > 0 && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ sources })}\n\n`);
      }

      // ── 4. Generate title FIRST (fast, before slow image gen) ─────────────
      const isFirstMessage = history.length === 0;
      if (isFirstMessage && userId && id > 0) {
        const newTitle = await generateTitle(content, req.log);
        req.log.info({ newTitle }, "[Axis] title generated");
        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
        }
      }

      // ── 5. Generate image (slow — generatingImage already sent during stream) ──
      if (hasImagePrompt && imagePromptText) {
        try {
          const imgResult = await generateImage(imagePromptText);
          savedContent += `\n[IMAGE:${imgResult.mimeType}|${imgResult.b64_json}]`;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ imageData: { b64: imgResult.b64_json, mimeType: imgResult.mimeType } })}\n\n`);
          }
        } catch (imgErr) {
          req.log.error({ imgErr }, "[Axis] Image generation failed");
        }
      }

      // ── 6. Persist assistant message (authenticated only) ─────────────────
      if (userId && id > 0) {
        await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });
      }

      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }

      if (userId) {
        extractAndSaveMemories(userId, content).catch(() => {});
      }
    }
  } catch (err) {
    req.log.error({ err }, "[Axis] Gemini error");
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
