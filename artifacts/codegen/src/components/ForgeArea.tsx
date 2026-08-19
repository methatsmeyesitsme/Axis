import { useState, useRef, useEffect, useCallback } from "react";
import {
  useGetForgeConversation,
  useCreateForgeConversation,
  useListForgeMessages,
  getListForgeConversationsQueryKey,
  getGetForgeConversationQueryKey,
  getListForgeMessagesQueryKey,
} from "@workspace/api-client-react";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Hammer, Square, LogIn, Play, ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { AIThinkingRow } from "./AIStatusLabel";

interface ForgeAreaProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
  onOpenAuth: () => void;
}

interface ToolStep {
  id: string;
  summary: string;
  status: "working" | "done" | "error";
}

export default function ForgeArea({ conversationId, onConversationCreated, onOpenAuth }: ForgeAreaProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [displayedContent, setDisplayedContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<string | null>(null);
  const [optimisticBaseline, setOptimisticBaseline] = useState(0);
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([]);

  const [guestMessages, setGuestMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const charQueueRef = useRef<string>("");
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamingContentRef = useRef<string>("");
  const streamDoneRef = useRef(false);
  const finalizeTargetRef = useRef<number | null>(null);
  const streamingJustFinishedRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const guestPendingUserRef = useRef<string>("");

  const isGuest = conversationId !== null && conversationId < 0;
  const canPreview = conversationId !== null && conversationId > 0;

  const { data: conversation } = useGetForgeConversation(conversationId!, {
    query: { enabled: conversationId !== null && conversationId > 0, queryKey: getGetForgeConversationQueryKey(conversationId!) },
  });
  const { data: serverMessages = [] } = useListForgeMessages(conversationId!, {
    query: { enabled: conversationId !== null && conversationId > 0, queryKey: getListForgeMessagesQueryKey(conversationId!) },
  });
  const createMutation = useCreateForgeConversation();

  useEffect(() => {
    if (serverMessages.length > prevMessagesLengthRef.current) {
      prevMessagesLengthRef.current = serverMessages.length;
      if (streamingJustFinishedRef.current) {
        streamingJustFinishedRef.current = false;
        setDisplayedContent("");
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
      setTimeout(() => {
        streamingBubbleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 40);
    }
  }, [isThinking]);

  useEffect(() => {
    if (!isStreaming && !isThinking && isNearBottom()) scrollToBottom();
  }, [serverMessages, isStreaming, isThinking, scrollToBottom, isNearBottom]);

  // Typewriter interval — same proven pattern as Codex/Cortex, including the fix
  // that guarantees this runs even when a request fails before streaming starts.
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
        setToolSteps([]);
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
        } else if (tid) {
          queryClient.invalidateQueries({ queryKey: getListForgeMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
        }
      }
    }, 8);

    return () => {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    };
  }, [isStreaming, queryClient]);

  const handleCancel = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    charQueueRef.current = "";
    streamDoneRef.current = false;
    streamingJustFinishedRef.current = false;
    setIsStreaming(false);
    setIsThinking(false);
    setDisplayedContent("");
    if (conversationId) {
      queryClient.invalidateQueries({ queryKey: getListForgeMessagesQueryKey(conversationId) });
    }
  };

  const handleSend = async () => {
    if (isStreaming) { handleCancel(); return; }
    if (!input.trim()) return;

    const fullContent = input;
    let targetId = conversationId;
    setOptimisticUserMessage(input);
    setOptimisticBaseline(serverMessages.length);
    setInput("");

    if (targetId === null) {
      try {
        const newConv = await createMutation.mutateAsync({ data: { title: "New App" } });
        targetId = newConv.id;
        onConversationCreated(targetId);
        if (user) queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
      } catch {
        // Creating the app itself failed (e.g. a transient network/server
        // error) — previously this was unhandled, crashing the whole send
        // with no feedback. Roll back the optimistic UI and let the person
        // retry instead.
        setOptimisticUserMessage(null);
        setInput(fullContent);
        charQueueRef.current = "Couldn't start a new app just now — please try again.";
        streamingContentRef.current = charQueueRef.current;
        streamDoneRef.current = true;
        finalizeTargetRef.current = null;
        setDisplayedContent("");
        setToolSteps([]);
        setIsThinking(false);
        setIsStreaming(true);
        return;
      }
    }

    guestPendingUserRef.current = fullContent;
    charQueueRef.current = "";
    streamingContentRef.current = "";
    streamDoneRef.current = false;
    streamingJustFinishedRef.current = false;
    finalizeTargetRef.current = targetId;
    prevMessagesLengthRef.current = serverMessages.length;
    setDisplayedContent("");
    setToolSteps([]);
    setIsThinking(true);
    setIsStreaming(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/forge/conversations/${targetId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fullContent, guestHistory: guestMessages }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let message = errorBody;
        try {
          const parsed = JSON.parse(errorBody) as { error?: string };
          message = parsed.error ?? errorBody;
        } catch {
          // Keep the plain response when it is not JSON.
        }
        throw new Error(message || `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("No response body");

      setIsThinking(false);
      setIsStreaming(true);

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
            if (data.content) {
              charQueueRef.current += data.content as string;
              streamingContentRef.current += data.content as string;
            }
            if (data.toolStart) {
              const { id: toolId, summary } = data.toolStart as { id: string; summary: string };
              setToolSteps((prev) => [...prev, { id: toolId, summary, status: "working" }]);
            }
            if (data.toolDone) {
              const { id: toolId } = data.toolDone as { id: string; summary: string };
              setToolSteps((prev) => prev.map((s) => (s.id === toolId ? { ...s, status: "done" } : s)));
            }
            if (data.toolError) {
              const { id: toolId } = data.toolError as { id: string; summary: string; error: string };
              setToolSteps((prev) => prev.map((s) => (s.id === toolId ? { ...s, status: "error" } : s)));
            }
            if (data.error) {
              const errorText = `Sorry, something went wrong: ${data.error}`;
              charQueueRef.current += errorText;
              streamingContentRef.current += errorText;
              done = true;
            }
            if (data.done) done = true;
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        charQueueRef.current += "Connection error. Please try again.";
      }
      setIsThinking(false);
    } finally {
      abortRef.current = null;
      setIsThinking(false);
      streamDoneRef.current = true;
      if (charQueueRef.current.length === 0) {
        streamDoneRef.current = false;
        streamingJustFinishedRef.current = true;
        setIsStreaming(false);
        setOptimisticUserMessage(null);
        setToolSteps([]);
        guestPendingUserRef.current = "";
        streamingContentRef.current = "";
        const tid = finalizeTargetRef.current;
        if (tid !== null && tid > 0) {
          queryClient.invalidateQueries({ queryKey: getListForgeMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListForgeConversationsQueryKey() });
        }
      } else {
        setIsStreaming(true);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleRunPreview = () => {
    if (!canPreview) return;
    window.open(`/api/forge/preview/${conversationId}/`, "_blank", "noopener,noreferrer");
  };

  const showOptimistic = optimisticUserMessage !== null && (isGuest || serverMessages.length <= optimisticBaseline);
  const showBubble = isStreaming || displayedContent.length > 0 || toolSteps.length > 0;

  const composer = (placeholder: string) => (
    <div className="p-4 border-t bg-background shadow-sm shrink-0">
      {!user && (
        <div className="max-w-4xl mx-auto mb-2">
          <button onClick={onOpenAuth} className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors py-1.5">
            <LogIn className="w-3.5 h-3.5" />
            Log in to save your apps
          </button>
        </div>
      )}
      <div className="max-w-4xl mx-auto">
        <div className="border border-input rounded-2xl bg-card shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all duration-200">
          <Textarea
            ref={inputRef}
            placeholder={placeholder}
            className="min-h-[110px] max-h-[320px] border-0 shadow-none rounded-none focus-visible:ring-0 resize-none px-4 pt-3 pb-2 bg-transparent text-[14.5px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isThinking}
          />
          <div className="flex items-center justify-end px-3 pb-2.5 pt-1">
            <Button
              className={`h-8 w-8 rounded-lg shrink-0 transition-all duration-200 ${isStreaming ? "bg-red-500 hover:bg-red-600" : "bg-primary hover:bg-primary/90"}`}
              onClick={handleSend}
              disabled={isThinking || (!input.trim() && !isStreaming)}
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
        {/* Run button — opens a live preview of the app's generated files/backend
            handlers in a new tab, served by the api-server's /forge/preview route. */}
        <button
          onClick={handleRunPreview}
          disabled={!canPreview}
          title={canPreview ? "Open a live preview of this app in a new tab" : "Log in and start building to preview your app"}
          className={`w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            canPreview
              ? "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          <Play className="w-3.5 h-3.5" />
          Run
        </button>
      </div>
    </div>
  );

  if (conversationId === null) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <div className="text-center px-8 pt-10 pb-0">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Hammer className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Forge</h1>
          <p className="text-muted-foreground text-base mt-2">Tell me what you want to build.</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-2xl font-semibold text-foreground">
            {user ? `Hi, ${user.username}! What are we building?` : "What are we building?"}
          </p>
        </div>
        {composer("Describe the app you want to build...")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="h-14 border-b flex items-center px-6 bg-card shrink-0">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">{isGuest ? "New App" : (conversation?.title ?? "Loading...")}</span>
          <span className="text-xs text-muted-foreground">Forge</span>
        </div>
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
                ))
            }
            {showOptimistic && (
              <MessageBubble role="user" content={optimisticUserMessage!} />
            )}
            {isThinking && <AIThinkingRow text="Working" />}
            {showBubble && (
              <div ref={streamingBubbleRef} className="flex flex-col gap-2">
                {toolSteps.length > 0 && (
                  <div className="flex flex-col gap-1.5 pl-1">
                    {toolSteps.map((step) => (
                      <div key={step.id} className="flex items-center gap-2 text-xs">
                        {step.status === "working" ? (
                          <span className="w-3 h-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin shrink-0" />
                        ) : step.status === "error" ? (
                          <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                        )}
                        <span className={step.status === "working" ? "text-muted-foreground" : "text-foreground"}>
                          {step.status === "working" ? "Working" : step.summary}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {(displayedContent.length > 0 || isStreaming) && (
                  <MessageBubble role="assistant" content={displayedContent} isStreaming={isStreaming} />
                )}
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

      {composer("Describe the app you want to build...")}
    </div>
  );
}
