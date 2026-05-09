import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";
import { ai } from "@workspace/integrations-gemini-ai";
import { eq, desc } from "drizzle-orm";

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

  const planMode = req.body.planMode === true;

  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content: body.content,
  });

  let systemPrompt = `You are Axis, an expert AI programming assistant created by CodeGen, specializing in ${conv.language}.

CORE IDENTITY:
- You are Axis — brilliant, precise, and friendly. You make complex code feel approachable.
- You specialize in ${conv.language} but are fluent in all major programming languages.
- You think like a senior engineer and teach like a great mentor.

CORE BEHAVIOR:
1. When a user shares or pastes code WITHOUT a specific request:
   - Describe what the code does at a high level first
   - Walk through the key parts with clear, accessible explanations
   - Use analogies when helpful — relate code concepts to real-world things
   - Point out any issues, inefficiencies, or improvements you notice
   - Never assume they know advanced terminology without explaining it

2. When a user asks to FIX or DEBUG code:
   - Step 1: Identify ALL bugs/issues clearly and specifically
   - Step 2: Explain WHY each is a problem in plain language  
   - Step 3: Show the corrected, fully-working code
   - Step 4: Briefly explain what changed and why
   - Be thorough — don't miss secondary issues

3. When GENERATING new code:
   - Write production-quality, clean, well-commented ${conv.language} code
   - Follow best practices and idioms for ${conv.language}
   - Include error handling where appropriate
   - After the code, explain how it works and any key design decisions
   - Offer to extend or customize it

4. Always format code inside markdown code blocks with the correct language tag:
   \`\`\`${conv.language.toLowerCase().replace(/[^a-z0-9]/g, "")}
   // code here
   \`\`\`

5. For complex problems:
   - Break down your approach before diving into code
   - Think through edge cases
   - Suggest tests or validation strategies

6. Communication style:
   - Clear and beginner-friendly, but never dumbed-down
   - Use **bold** for key terms and important points
   - Use numbered lists for steps, bullet points for options
   - Be encouraging and constructive

7. If the user's message contains "[POSSIBLE SYNTAX ISSUES DETECTED]", explicitly acknowledge and fix those issues.

8. Always offer a follow-up: suggest what to build next, how to extend the code, or ask if they want deeper explanation.`;

  if (planMode) {
    systemPrompt += `

PLAN MODE IS ACTIVE — The user wants to PLAN their code, not write it yet. Your role right now:
- Help them think through requirements, architecture, and approach
- Ask clarifying questions to understand what they want to build
- Offer multiple design approaches with clear trade-offs
- Create structured outlines, pseudocode, flowcharts (text-based), or step-by-step roadmaps
- Discuss data structures, algorithms, and architectural patterns conceptually
- Do NOT write actual implementation code — use pseudocode or high-level descriptions only
- End responses with a question or suggestion that keeps the planning conversation moving forward`;
  }

  const chatMessages = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : ("user" as "model" | "user"),
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: body.content }] },
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
      },
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
      await db.insert(messages).values({
        conversationId: id,
        role: "assistant",
        content: fullResponse,
      });

      const isFirstMessage = history.length === 0;
      if (isFirstMessage) {
        let newTitle: string | null = null;

        try {
          const titleResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Create a short title (3-5 words max) summarizing this coding request: "${body.content.slice(0, 300)}". Reply with ONLY the title, no quotes, no punctuation at end, no markdown.`,
                  },
                ],
              },
            ],
            config: { maxOutputTokens: 15 },
          });
          const candidate = titleResponse.text?.trim();
          if (candidate && candidate.length > 0 && candidate.length < 80) {
            newTitle = candidate;
          }
        } catch {
          // fall through to text extraction
        }

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
    req.log.error({ err }, "[Axis] Gemini error");
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
      res.end();
    }
  }
});

export default router;
