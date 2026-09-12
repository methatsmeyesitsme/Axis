import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import {
  useGetOpenaiConversation,
  useCreateOpenaiConversation,
  useListOpenaiMessages,
  getListOpenaiConversationsQueryKey,
  getGetOpenaiConversationQueryKey,
  getListOpenaiMessagesQueryKey,
} from "@workspace/api-client-react";
import LanguageSelector from "./LanguageSelector";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Code2, Square, AlertTriangle, LogIn, Plus, Paperclip, X, ChevronDown, ChevronLeft, Globe } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { AIThinkingRow } from "./AIStatusLabel";
import { resizeImageFile } from "@/lib/utils";

interface ChatAreaProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
  onOpenAuth: () => void;
  forgeHint?: boolean;
  onOpenForge?: () => void;
}

interface Attachment {
  name: string;
  content: string;
  isImage: boolean;
  b64?: string;
  mimeType?: string;
  previewUrl?: string;
}

function looksLikeCode(text: string): boolean {
  const codePatterns = [
    /^\s*(function|def|class|import|from|const|let|var|if|for|while|return)\b/m,
    /[{};]\s*\n/,
    /^\s{2,}[\w(]/m,
    /\bprint\(|console\.log\(|System\.out|printf\(/,
    /=>\s*\{|=>\s*\w+/,
    /```[\s\S]*```/,
  ];
  return text.split("\n").length > 3 && codePatterns.some((p) => p.test(text));
}

function checkSyntaxIssues(text: string): string[] {
  const issues: string[] = [];
  if (!text.trim()) { issues.push("Empty input"); return issues; }
  if (looksLikeCode(text)) {
    const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
    const stack: string[] = [];
    let inString = false;
    let stringChar = "";
    for (const ch of text) {
      if (inString) { if (ch === stringChar) inString = false; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inString = true; stringChar = ch; continue; }
      if ("({[".includes(ch)) stack.push(ch);
      else if (")}]".includes(ch)) {
        if (stack[stack.length - 1] !== pairs[ch]) { issues.push("Mismatched or missing brackets"); break; }
        stack.pop();
      }
    }
    if (stack.length > 0 && !issues.includes("Mismatched or missing brackets")) issues.push("Unclosed brackets detected");
  }
  return issues;
}

function buildSmartPrompt(userInput: string): { prompt: string; warning: string | null } {
  const input = userInput.trim();
  const isCode = looksLikeCode(input);
  const issues = checkSyntaxIssues(input);
  const hasFixKeyword = /\b(fix|debug|error|bug|broken|wrong|issue|problem|not working)\b/i.test(input);
  const isJustCode = isCode && input.split("\n").length > 4 && !input.toLowerCase().includes("fix") && !input.includes("?");
  let prompt = input;
  let warning: string | null = null;
  if (issues.length > 0 && isCode) {
    warning = `Heads up: ${issues.join(", ")} found in your code. Sending it anyway with a note for Axis.`;
    prompt = `${input}\n\n[POSSIBLE SYNTAX ISSUES DETECTED: ${issues.join(", ")}]`;
  }
  if (isJustCode && !hasFixKeyword) {
    prompt = `${prompt}\n\n[Please explain what this code does in beginner-friendly terms, then break down the key parts.]`;
  } else if (hasFixKeyword && isCode) {
    prompt = `${prompt}\n\n[Smart debug mode: Find the bug, explain why it's a problem in simple terms, then show the fixed code.]`;
  }
  return { prompt, warning };
}

export default function ChatArea({ conversationId, onConversationCreated, onOpenAuth, forgeHint, onOpenForge }: ChatAreaProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedLanguage, setSelectedLanguage] = useState("TypeScript");
  const [input, setInput] = useState("");
  const [displayedContent, setDisplayedContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Thinking");
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [streamingImages, setStreamingImages] = useState<Array<{ b64: string; mimeType: string }>>([]);
  const [streamingFiles, setStreamingFiles] = useState<Array<{ filename: string; b64: string; mimeType: string }>>([]);
  const [streamingSources, setStreamingSources] = useState<Array<{ url: string; title: string }>>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<string | null>(null);
  const [optimisticBaseline, setOptimisticBaseline] = useState(0);
  const [guestMessages, setGuestMessages] = useState<Array<{role: "user"|"assistant"; content: string}>>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charQueueRef = useRef<string>("");
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamingContentRef = useRef<string>("");
  const streamDoneRef = useRef(false);
  const finalizeTargetRef = useRef<number | null>(null);
  const streamingJustFinishedRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const guestPendingUserRef = useRef<string>("");
  const thinkingStartedAtRef = useRef<number>(0);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_THINKING_MS = 1400;

  const isGuest = conversationId !== null && conversationId < 0;

  const { data: conversation } = useGetOpenaiConversation(conversationId!, {
    query: { enabled: conversationId !== null && conversationId > 0, queryKey: getGetOpenaiConversationQueryKey(conversationId!) },
  });
  const { data: serverMessages = [] } = useListOpenaiMessages(conversationId!, {
    query: { enabled: conversationId !== null && conversationId > 0, queryKey: getListOpenaiMessagesQueryKey(conversationId!) },
  });
  const createMutation = useCreateOpenaiConversation();

  useEffect(() => {
    if (serverMessages.length > prevMessagesLengthRef.current) {
      prevMessagesLengthRef.current = serverMessages.length;
      if (streamingJustFinishedRef.current) {
        streamingJustFinishedRef.current = false;
        setDisplayedContent("");
        setStreamingImages([]);
        setStreamingFiles([]);
        setStreamingSources([]);
        setIsGeneratingImage(false);
      }
    }
  }, [serverMessages]);

  const isNearBottom = useCallback(() => {
    if (!scrollRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    return scrollHeight - scrollTop - clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      setShowScrollButton(false);
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollButton(scrollHeight - scrollTop - clientHeight > 120);
  }, []);

  useEffect(() => {
    if (isThinking && streamingBubbleRef.current) {
      setTimeout(() => streamingBubbleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
    }
  }, [isThinking]);

  useEffect(() => {
    if (!isStreaming && !isThinking && isNearBottom()) scrollToBottom();
  }, [serverMessages, isStreaming, isThinking, scrollToBottom, isNearBottom]);

  useEffect(() => {
    if (!isStreaming) return;
    displayTimerRef.current = setInterval(() => {
      if (charQueueRef.current.length > 0) {
        const batch = charQueueRef.current.slice(0, 1);
        charQueueRef.current = charQueueRef.current.slice(1);
        setDisplayedContent((prev) => prev + batch);
      } else if (streamDoneRef.current) {
        clearInterval(displayTimerRef.current!);
        displayTimerRef.current = null;
        streamDoneRef.current = false;
        const tid = finalizeTargetRef.current;
        setIsStreaming(false);
        setOptimisticUserMessage(null);
        streamingJustFinishedRef.current = true;
        if (tid !== null && tid < 0) {
          const userMsg = guestPendingUserRef.current;
          const aiMsg = streamingContentRef.current;
          if (userMsg) {
            setGuestMessages((prev) => [
              ...prev,
              { role: "user" as const, content: userMsg },
              { role: "assistant" as const, content: aiMsg },
            ]);
          }
          guestPendingUserRef.current = "";
          streamingContentRef.current = "";
          setDisplayedContent("");
          setStreamingImages([]);
          setStreamingFiles([]);
          setStreamingSources([]);
          setIsGeneratingImage(false);
        } else if (tid) {
          queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        }
      }
    }, 8);
    return () => {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    };
  }, [isStreaming, queryClient]);

  useEffect(() => {
    if (pendingTitle) {
      const tid = finalizeTargetRef.current ?? conversationId;
      queryClient.setQueryData(
        getListOpenaiConversationsQueryKey(),
        (old: Array<{ id: number; title: string; [key: string]: unknown }> | undefined) =>
          old?.map((c) => (c.id === tid ? { ...c, title: pendingTitle } : c)),
      );
      if (tid) {
        queryClient.setQueryData(
          getGetOpenaiConversationQueryKey(tid),
          (old: { title: string; [key: string]: unknown } | undefined) =>
            old ? { ...old, title: pendingTitle } : old,
        );
      }
      queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
      if (tid) queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(tid) });
      setPendingTitle(null);
    }
  }, [pendingTitle, conversationId, queryClient]);

  const handleCancel = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
    charQueueRef.current = "";
    streamDoneRef.current = false;
    streamingContentRef.current = "";
    streamingJustFinishedRef.current = false;
    setIsStreaming(false);
    setIsThinking(false);
    setIsGeneratingImage(false);
    setDisplayedContent("");
    setStreamingImages([]);
    setStreamingFiles([]);
    setStreamingSources([]);
    queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(conversationId!) });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        resizeImageFile(file)
          .then(({ dataUrl, b64, mimeType }) => {
            setAttachments((prev) => [
              ...prev,
              { name: file.name, content: `[IMAGE:${mimeType}|${b64}]`, isImage: true, b64, mimeType, previewUrl: dataUrl },
            ]);
          })
          .catch(() => {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string;
              const commaIdx = dataUrl.indexOf(",");
              const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
              const mimeType = file.type || "image/png";
              setAttachments((prev) => [
                ...prev,
                { name: file.name, content: `[IMAGE:${mimeType}|${b64}]`, isImage: true, b64, mimeType, previewUrl: dataUrl },
              ]);
            };
            reader.readAsDataURL(file);
          });
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target?.result as string;
          setAttachments((prev) => [...prev, { name: file.name, content: `File: ${file.name}\n\`\`\`\n${text}\n\`\`\``, isImage: false }]);
        };
        reader.readAsText(file);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => setAttachments((prev) => prev.filter((_, i) => i !== index));

  const handleSend = async () => {
    if (isStreaming) { handleCancel(); return; }
    if (!input.trim() && attachments.length === 0) return;

    const attachmentText = attachments.map((a) => a.content).join("\n\n");
    const rawInput = attachmentText ? `${attachmentText}\n\n${input}` : input;
    const { prompt, warning: syntaxWarning } = buildSmartPrompt(rawInput);
    setWarning(syntaxWarning);

    let targetId = conversationId;
    const optimisticText = attachmentText
      ? `${attachmentText}${input.trim() ? `\n\n${input.trim()}` : ""}`
      : input;
    setOptimisticUserMessage(optimisticText);
    setOptimisticBaseline(serverMessages.length);
    setInput("");
    setAttachments([]);

    if (targetId === null) {
      const newConv = await createMutation.mutateAsync({ data: { title: "New Chat", language: selectedLanguage } });
      targetId = newConv.id;
      onConversationCreated(targetId);
      if (user) queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
    }

    guestPendingUserRef.current = prompt;
    charQueueRef.current = "";
    streamingContentRef.current = "";
    streamDoneRef.current = false;
    streamingJustFinishedRef.current = false;
    finalizeTargetRef.current = targetId;
    prevMessagesLengthRef.current = serverMessages.length;
    setDisplayedContent("");
    setStreamingImages([]);
    setStreamingFiles([]);
    setStreamingSources([]);
    setIsGeneratingImage(false);
    setIsThinking(true);
    setStatusLabel("Thinking it through");
    setIsStreaming(false);
    thinkingStartedAtRef.current = Date.now();
    if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/openai/conversations/${targetId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prompt, planMode, language: selectedLanguage, guestHistory: guestMessages }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("Network error");
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.imageFailed) setIsGeneratingImage(false);
            if (data.status === "thinking" || data.summary) {
              const label = (data.summary as string) || "Thinking it through";
              setStatusLabel(label.split(/\s+/).slice(0, 5).join(" "));
              setIsThinking(true);
            }
            if (data.toolStart) {
              const { summary } = data.toolStart as { summary?: string };
              if (summary) setStatusLabel(summary.split(/\s+/).slice(0, 5).join(" "));
              setIsThinking(true);
            }
            if (data.toolDone) {
              const { summary } = data.toolDone as { summary?: string };
              if (summary) setStatusLabel(summary.split(/\s+/).slice(0, 5).join(" "));
            }
            if (data.toolError) {
              const { summary } = data.toolError as { summary?: string };
              if (summary) setStatusLabel(summary.split(/\s+/).slice(0, 5).join(" "));
            }
            if (data.content) {
              streamingContentRef.current += data.content as string;
              charQueueRef.current += data.content as string;
              const elapsed = Date.now() - thinkingStartedAtRef.current;
              const wait = Math.max(0, MIN_THINKING_MS - elapsed);
              const reveal = () => {
                thinkingTimerRef.current = null;
                setIsThinking(false);
                setIsStreaming(true);
              };
              if (wait === 0) {
                if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
                reveal();
              } else if (!thinkingTimerRef.current) {
                thinkingTimerRef.current = setTimeout(reveal, wait);
              }
            }
            if (data.generatingImage) flushSync(() => setIsGeneratingImage(true));
            if (data.imageData) {
              setIsGeneratingImage(false);
              const { b64, mimeType } = data.imageData as { b64: string; mimeType: string };
              setStreamingImages((prev) => [...prev, { b64, mimeType }]);
            }
            if (data.fileData) {
              const { filename, b64, mimeType } = data.fileData as { filename: string; b64: string; mimeType: string };
              setStreamingFiles((prev) => [...prev, { filename, b64, mimeType }]);
            }
            if (data.sources) setStreamingSources(data.sources as Array<{ url: string; title: string }>);
            if (data.error) {
              const errorText = `Sorry, something went wrong: ${data.error}`;
              charQueueRef.current += errorText;
              streamingContentRef.current += errorText;
              done = true;
              setIsThinking(false);
              setIsStreaming(true);
            }
            if (data.titleUpdate) setPendingTitle(data.titleUpdate as string);
            if (data.done) done = true;
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        charQueueRef.current += "Connection error. Please try again.";
        setIsStreaming(true);
      }
      setIsThinking(false);
    } finally {
      abortRef.current = null;
      streamDoneRef.current = true;
      if (charQueueRef.current.length === 0 && streamingContentRef.current.length === 0) {
        if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
        streamDoneRef.current = false;
        streamingJustFinishedRef.current = true;
        setIsThinking(false);
        setIsStreaming(false);
        setOptimisticUserMessage(null);
        guestPendingUserRef.current = "";
        streamingContentRef.current = "";
        const tid = finalizeTargetRef.current;
        if (tid !== null && tid > 0) {
          queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        }
      } else if (!isStreaming) {
        // Ensure typewriter can drain if thinking timer already fired or content arrived late
        const elapsed = Date.now() - thinkingStartedAtRef.current;
        const wait = Math.max(0, MIN_THINKING_MS - elapsed);
        if (wait === 0) {
          setIsThinking(false);
          setIsStreaming(true);
        } else if (!thinkingTimerRef.current) {
          thinkingTimerRef.current = setTimeout(() => {
            thinkingTimerRef.current = null;
            setIsThinking(false);
            setIsStreaming(true);
          }, wait);
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const showOptimistic = optimisticUserMessage !== null && (isGuest || serverMessages.length <= optimisticBaseline);
  // Never show empty bubble next to thinking — only after thinking ends
  const showBubble = !isThinking && (displayedContent.length > 0 || isStreaming);

  const inputBar = (placeholder: string) => (
    <div className="p-4 border-t bg-background shadow-sm shrink-0">
      {!user && (
        <div className="max-w-4xl mx-auto mb-2">
          <button onClick={onOpenAuth} className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors py-1.5">
            <LogIn className="w-3.5 h-3.5" />
            Log in to save your chats
          </button>
        </div>
      )}
      {warning && (
        <div className="max-w-4xl mx-auto mb-2 flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      <div className="max-w-4xl mx-auto">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-muted border border-border rounded-lg px-2.5 py-1 text-xs text-foreground">
                {att.isImage && att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} className="w-5 h-5 rounded object-cover shrink-0" />
                ) : (
                  <Paperclip className="w-3 h-3 text-muted-foreground" />
                )}
                <span className="max-w-[120px] truncate">{att.name}</span>
                <button onClick={() => removeAttachment(i)} className="text-muted-foreground hover:text-foreground ml-0.5">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="border border-input rounded-2xl bg-card shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all duration-200">
          <Textarea
            ref={inputRef}
            placeholder={placeholder}
            className="min-h-[110px] max-h-[320px] border-0 shadow-none rounded-none focus-visible:ring-0 resize-none px-4 pt-3 pb-2 bg-transparent text-[14.5px]"
            value={input}
            onChange={(e) => { setInput(e.target.value); if (warning) setWarning(null); }}
            onKeyDown={handleKeyDown}
            disabled={isThinking}
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept="image/*,text/*,.js,.ts,.tsx,.jsx,.py,.java,.cpp,.cs,.go,.rs,.php,.rb,.swift,.kt,.dart,.lua,.sql,.sh,.r,.html,.css,.json,.yaml,.yml,.md,.txt"
                onChange={handleFileUpload}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => fileInputRef.current?.click()} title="Attach file or image" type="button">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2.5">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} className="rounded border-input w-3.5 h-3.5 accent-primary cursor-pointer" />
                Plan
              </label>
              <Button
                className={`h-8 w-8 rounded-lg shrink-0 transition-all duration-200 ${isStreaming ? "bg-red-500 hover:bg-red-600" : "bg-primary hover:bg-primary/90"}`}
                onClick={handleSend}
                disabled={isThinking || (!input.trim() && attachments.length === 0 && !isStreaming)}
                size="icon"
              >
                {isThinking ? (
                  <div className="flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:300ms]" />
                  </div>
                ) : isStreaming ? (
                  <Square className="w-4 h-4 fill-white" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-2 transition-all">
          {planMode ? "Plan mode on — Axis will discuss and outline, not write code" : isStreaming ? "Click stop to cancel" : "Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );

  if (conversationId === null) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background relative">
        {forgeHint && (
          <button onClick={onOpenForge} className="absolute top-14 right-6 flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-primary transition-colors z-10">
            <ChevronLeft className="w-3.5 h-3.5" />
            Swipe left to build an app
          </button>
        )}
        <div className="text-center px-8 pt-10 pb-0">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Code2 className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Axis</h1>
          <p className="text-muted-foreground text-base mt-2">Your intelligent coding partner. Select a language to get started.</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-2xl font-semibold text-foreground">{user ? `Ready to code, ${user.username}?` : "Ready to code?"}</p>
        </div>
        <div className="px-8 pb-3 max-w-xs mx-auto w-full">
          <LanguageSelector value={selectedLanguage} onChange={setSelectedLanguage} />
        </div>
        {inputBar("Have Axis write code or explain code.")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="h-14 border-b flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">{isGuest ? "New Chat" : (conversation?.title ?? "Loading...")}</span>
          <span className="text-xs text-muted-foreground">{isGuest ? selectedLanguage : (conversation?.language ?? selectedLanguage)}</span>
        </div>
        {planMode && (
          <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-1 rounded-full font-medium">Plan Mode</span>
        )}
        {forgeHint && (
          <button onClick={onOpenForge} className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-primary transition-colors relative z-20 mr-24">
            <ChevronLeft className="w-3.5 h-3.5" />
            Swipe left to build an app
          </button>
        )}
      </div>

      <div className="flex-1 relative overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto p-6" style={{ scrollBehavior: "smooth", touchAction: "pan-y" }}>
          <div className="max-w-4xl mx-auto space-y-6 pb-4">
            {isGuest
              ? guestMessages.map((msg, i) => (
                  <MessageBubble key={i} role={msg.role} content={msg.content} />
                ))
              : serverMessages.map((msg) => (
                  <MessageBubble key={msg.id} role={msg.role as "user" | "assistant"} content={msg.content} />
                ))}
            {showOptimistic && <MessageBubble role="user" content={optimisticUserMessage!} />}
            {isThinking && <AIThinkingRow text={statusLabel} />}
            {showBubble && (
              <div ref={streamingBubbleRef} className="flex flex-col gap-0.5">
                {streamingSources.length > 0 && (
                  <div className="flex items-center gap-1.5 pl-11 mb-0.5">
                    <Globe className="w-3 h-3 text-muted-foreground/70" />
                    <span className="text-xs text-muted-foreground/70">Searched the web</span>
                  </div>
                )}
                <MessageBubble
                  role="assistant"
                  content={displayedContent}
                  isStreaming={isStreaming}
                  isGeneratingImage={isGeneratingImage}
                  streamingImages={streamingImages}
                  streamingFiles={streamingFiles}
                  sources={streamingSources.length > 0 ? streamingSources : undefined}
                />
              </div>
            )}
          </div>
        </div>
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary/90 transition-all animate-in fade-in slide-in-from-bottom-2 duration-200"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            Scroll to latest
          </button>
        )}
      </div>

      {inputBar("Ask Axis anything...")}
    </div>
  );
}
