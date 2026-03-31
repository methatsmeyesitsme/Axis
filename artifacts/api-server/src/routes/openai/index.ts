import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { eq, desc, and, isNull } from "drizzle-orm";

const router: IRouter = Router();

router.get("/conversations", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    res.json([]);
    return;
  }
  const result = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.createdAt));
  res.json(
    result.map((c) => ({
      id: c.id,
      title: c.title,
      language: c.language,
      createdAt: c.createdAt,
    }))
  );
});

router.post("/conversations", async (req, res) => {
  const body = CreateOpenaiConversationBody.parse(req.body);
  const userId = req.session?.userId ?? null;
  const [created] = await db
    .insert(conversations)
    .values({ title: body.title, language: body.language, userId })
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
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json({
    id: conv.id,
    title: conv.title,
    language: conv.language,
    createdAt: conv.createdAt,
    messages: msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
});

router.delete("/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json(
    msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }))
  );
});

router.post("/conversations/:id/messages", async (req, res) => {
  const id = Number(req.params.id);
  const body = SendOpenaiMessageBody.parse(req.body);

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content: body.content,
  });

  const systemPrompt = `You are CodeGen, an expert AI programming assistant specializing in ${conv.language}.

CORE BEHAVIOR:
1. When a user shares or pastes code WITHOUT a specific request, always:
   - First briefly describe what the code does overall
   - Then walk through the key parts in plain, beginner-friendly language
   - Use simple analogies when helpful
   - Do NOT assume they know advanced terms

2. When a user asks to FIX or DEBUG code, always follow this exact order:
   - Step 1: Identify the bug(s) and state them clearly
   - Step 2: Briefly explain WHY it's a bug in simple terms
   - Step 3: Provide the corrected code
   - Never jump straight to a fix without explaining the problem

3. When GENERATING new code:
   - Write clean, well-commented ${conv.language} code
   - Include a brief explanation of how it works after the code block
   - Use simple language, suitable for beginners

4. Always format code inside markdown code blocks with the language tag, e.g.:
   \`\`\`${conv.language.toLowerCase().replace(/[^a-z0-9]/g, "")}
   // code here
   \`\`\`

5. Keep explanations clear and beginner-friendly. Never be condescending, but do explain things thoroughly.

6. If the user's message contains a note like "[POSSIBLE SYNTAX ISSUES DETECTED]", acknowledge those specific issues in your response.`;

  const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: body.content },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let fullResponse = "";

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      if (res.writableEnded) break;
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!res.writableEnded) {
      await db.insert(messages).values({
        conversationId: id,
        role: "assistant",
        content: fullResponse,
      });

      const isFirstMessage = history.length === 0;
      if (isFirstMessage) {
        let newTitle: string | null = null;

        // Try AI title generation first
        try {
          const titleResponse = await openai.chat.completions.create({
            model: "gpt-5.2",
            max_completion_tokens: 15,
            messages: [
              {
                role: "user",
                content: `Create a short title (3-5 words max) summarizing this coding request: "${body.content.slice(0, 300)}". Reply with ONLY the title, no quotes, no punctuation at end, no markdown.`,
              },
            ],
            stream: false,
          });
          const candidate = titleResponse.choices[0]?.message?.content?.trim();
          if (candidate && candidate.length > 0 && candidate.length < 80) {
            newTitle = candidate;
          }
        } catch {
          // fall through to text extraction
        }

        // Fallback: extract meaningful words from the first message
        if (!newTitle) {
          const cleaned = body.content
            .replace(/```[\s\S]*?```/g, "")
            .replace(/[`*_#]/g, "")
            .trim();
          const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
          newTitle = words.length > 0 ? words : "Untitled Chat";
        }

        if (newTitle) {
          await db
            .update(conversations)
            .set({ title: newTitle })
            .where(eq(conversations.id, id));
          res.write(`data: ${JSON.stringify({ titleUpdate: newTitle })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
