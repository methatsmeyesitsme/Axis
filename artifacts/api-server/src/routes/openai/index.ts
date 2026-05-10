import { Router, type IRouter } from "express";
import { db, conversations, messages, userMemories } from "@workspace/db";
import { ai, generateImage } from "@workspace/integrations-gemini-ai";
import { eq, desc, isNull } from "drizzle-orm";

const router: IRouter = Router();

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
    // Keep only latest 30 memories per user
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
  const { title = "New Chat", language = "TypeScript" } = req.body as { title?: string; language?: string };
  const userId = req.session?.userId ?? null;
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
  const { content, planMode = false } = req.body as { content: string; planMode?: boolean };

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }

  const history = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);

  await db.insert(messages).values({ conversationId: id, role: "user", content });

  const userId = req.session?.userId ?? null;
  const memoryBlock = userId ? await loadMemories(userId) : "";

  let systemPrompt = `You are Axis, an expert AI programming assistant created by CodeGen, specializing in ${conv.language}.

CORE IDENTITY:
- You are Axis — brilliant, precise, and friendly. You make complex code feel approachable.
- You specialize in ${conv.language} but are fluent in all major programming languages.
- You think like a senior engineer and teach like a great mentor.${memoryBlock ? `\n\nWHAT YOU KNOW ABOUT THIS USER:\n${memoryBlock}` : ""}

CORE BEHAVIOR:
1. When a user shares or pastes code WITHOUT a specific request:
   - Describe what the code does at a high level first
   - Walk through the key parts with clear, accessible explanations
   - Use analogies when helpful — relate code concepts to real-world things
   - Point out any issues, inefficiencies, or improvements you notice

2. When a user asks to FIX or DEBUG code:
   - Step 1: Identify ALL bugs/issues clearly and specifically
   - Step 2: Explain WHY each is a problem in plain language
   - Step 3: Show the corrected, fully-working code
   - Step 4: Briefly explain what changed and why

3. When GENERATING new code:
   - Write production-quality, clean, well-commented ${conv.language} code
   - Follow best practices and idioms for ${conv.language}
   - Include error handling where appropriate
   - After the code, explain how it works and key design decisions

4. Always format code in markdown code blocks with the correct language tag.

5. Communication style: Clear and beginner-friendly, use **bold** for key terms, numbered lists for steps.

6. If the user's message contains "[POSSIBLE SYNTAX ISSUES DETECTED]", explicitly acknowledge and fix those issues.

7. Always offer a follow-up: suggest what to build next or ask if they want a deeper explanation.

IMAGE GENERATION: When the user asks you to generate, create, draw, make, or show an image, picture, illustration, photo, or artwork, you MUST include this tag on its own line at the very end of your response:
[IMAGE_PROMPT: a detailed visual description of the image]
Do not use ASCII art. Just include the tag — the image will be generated automatically.

FILE GENERATION: When the user asks for a .txt or text file, put the content in a \`\`\`text code block. For CSV data or spreadsheets, use a \`\`\`csv code block. The user can download these files directly from the code block.`;

  if (planMode) {
    systemPrompt += `

PLAN MODE IS ACTIVE — Help the user plan, not implement. Use pseudocode only. End with a question that moves planning forward.`;
  }

  const chatMessages = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : ("user" as "model" | "user"),
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: content }] },
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
      config: { maxOutputTokens: 8192, systemInstruction: systemPrompt },
    });

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    if (!res.writableEnded) {
      // Detect and process image generation request
      const imagePromptMatch = fullResponse.match(/\[IMAGE_PROMPT:\s*([\s\S]+?)\]\s*$/i);
      let savedContent = fullResponse;

      if (imagePromptMatch) {
        const imagePrompt = imagePromptMatch[1].trim();
        // Strip the tag from what's stored and shown as text
        savedContent = fullResponse.slice(0, imagePromptMatch.index).trimEnd();
        try {
          const imgResult = await generateImage(imagePrompt);
          // Append image tag to saved content
          savedContent += `\n[IMAGE:${imgResult.mimeType}|${imgResult.b64_json}]`;
          // Send image data to frontend
          res.write(`data: ${JSON.stringify({ imageData: { b64: imgResult.b64_json, mimeType: imgResult.mimeType } })}\n\n`);
        } catch (imgErr) {
          req.log.error({ imgErr }, "[Axis] Image generation failed");
        }
      }

      await db.insert(messages).values({ conversationId: id, role: "assistant", content: savedContent });

      const isFirstMessage = history.length === 0;
      if (isFirstMessage) {
        // Generate title from user's first message
        let newTitle: string | null = null;
        try {
          const titleResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{
              role: "user",
              parts: [{ text: `What is the main topic or task in this message? Give a short title (3-5 words). Reply with ONLY the title, no punctuation at end.\n\nMessage: "${content.slice(0, 400)}"` }],
            }],
            config: { maxOutputTokens: 20 },
          });
          const candidate = titleResponse.text?.trim().replace(/["'.!?]$/g, "");
          if (candidate && candidate.length > 0 && candidate.length < 80) newTitle = candidate;
        } catch { /* fall through */ }

        if (!newTitle) newTitle = "New Chat";

        await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, id));
        res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

      // Extract and save memories in the background (after response sent)
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
