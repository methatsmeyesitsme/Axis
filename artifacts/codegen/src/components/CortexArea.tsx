import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import {
  useGetCortexConversation,
  useCreateCortexConversation,
  useListCortexMessages,
  getListCortexConversationsQueryKey,
  getGetCortexConversationQueryKey,
  getListCortexMessagesQueryKey,
} from "@workspace/api-client-react";
import MessageBubble from "./MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Sparkles, Square, LogIn, Plus, Paperclip, X, ChevronDown, Globe } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { AIThinkingRow } from "./AIStatusLabel";

interface CortexAreaProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
  onOpenAuth: () => void;
}

interface Attachment {
  name: string;
  content: string;
}

export default function CortexArea({ conversationId, onConversationCreated, onOpenAuth }: CortexAreaProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [displayedContent, setDisplayedContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [streamingImages, setStreamingImages] = useState<Array<{ b64: string; mimeType: string }>>([]);
  const [streamingFiles, setStreamingFiles] = useState<Array<{ filename: string; b64: string; mimeType: string }>>([]);
  const [streamingSources, setStreamingSources] = useState<Array<{ url: string; title: string }>>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<string | null>(null);
  const [optimisticBaseline, setOptimisticBaseline] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charQueueRef = useRef<string>("");
  const displayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamDoneRef = useRef(false);
  const finalizeTargetRef = useRef<number | null>(null);
  const streamingJustFinishedRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);

  const { data: conversation } = useGetCortexConversation(conversationId!, {
    query: { enabled: !!conversationId, queryKey: getGetCortexConversationQueryKey(conversationId!) },
  });
  const { data: serverMessages = [] } = useListCortexMessages(conversationId!, {
    query: { enabled: !!conversationId, queryKey: getListCortexMessagesQueryKey(conversationId!) },
  });
  const createMutation = useCreateCortexConversation();

  // ── Fix: hide streaming bubble only after server messages arrive ──────────
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

  // Scroll to top of streaming bubble when it appears
  useEffect(() => {
    if (isThinking && streamingBubbleRef.current) {
      setTimeout(() => {
        streamingBubbleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 40);
    }
  }, [isThinking]);

  // Auto-scroll only for new server messages when near bottom
  useEffect(() => {
    if (!isStreaming && !isThinking && isNearBottom()) scrollToBottom();
  }, [serverMessages, isStreaming, isThinking, scrollToBottom, isNearBottom]);

  // Typewriter interval
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
        if (tid) {
          queryClient.invalidateQueries({ queryKey: getListCortexMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
        }
      }
    }, 8);

    return () => {
      if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    };
  }, [isStreaming, queryClient]);

  // Title update — write directly to cache so the sidebar updates immediately,
  // without waiting for a network refetch (which can 304 if ETag matches)
  useEffect(() => {
    if (pendingTitle) {
      const tid = finalizeTargetRef.current ?? conversationId;
      queryClient.setQueryData(
        getListCortexConversationsQueryKey(),
        (old: Array<{ id: number; title: string; [key: string]: unknown }> | undefined) =>
          old?.map((c) => (c.id === tid ? { ...c, title: pendingTitle } : c)),
      );
      if (tid) {
        queryClient.setQueryData(
          getGetCortexConversationQueryKey(tid),
          (old: { title: string; [key: string]: unknown } | undefined) =>
            old ? { ...old, title: pendingTitle } : old,
        );
      }
      queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
      if (tid) queryClient.invalidateQueries({ queryKey: getGetCortexConversationQueryKey(tid) });
      setPendingTitle(null);
    }
  }, [pendingTitle, conversationId, queryClient]);

  const handleCancel = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (displayTimerRef.current) clearInterval(displayTimerRef.current);
    charQueueRef.current = "";
    streamDoneRef.current = false;
    streamingJustFinishedRef.current = false;
    setIsStreaming(false);
    setIsThinking(false);
    setIsGeneratingImage(false);
    setDisplayedContent("");
    setStreamingImages([]);
    setStreamingFiles([]);
    setStreamingSources([]);
    if (conversationId) {
      queryClient.invalidateQueries({ queryKey: getListCortexMessagesQueryKey(conversationId) });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        setAttachments((prev) => [...prev, { name: file.name, content: `[Image attached: ${file.name}]` }]);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target?.result as string;
          setAttachments((prev) => [...prev, { name: file.name, content: `File: ${file.name}\n\`\`\`\n${text}\n\`\`\`` }]);
        };
        reader.readAsText(file);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    if (isStreaming) { handleCancel(); return; }
    if (!input.trim() && attachments.length === 0) return;

    const attachmentText = attachments.map((a) => a.content).join("\n\n");
    const fullContent = attachmentText ? `${attachmentText}\n\n${input}` : input;

    let targetId = conversationId;
    const optimisticText = input.trim() || (attachments.length > 0 ? `[${attachments.length} file${attachments.length > 1 ? "s" : ""} attached]` : "");
    setOptimisticUserMessage(optimisticText);
    setOptimisticBaseline(serverMessages.length);
    setInput("");
    setAttachments([]);

    if (targetId === null) {
      const newConv = await createMutation.mutateAsync({ data: { title: "New Chat" } });
      targetId = newConv.id;
      onConversationCreated(targetId);
      if (user) queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
    }

    charQueueRef.current = "";
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
    setIsStreaming(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/cortex/conversations/${targetId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fullContent }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("Network error");
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
            }
            if (data.generatingImage) {
              // flushSync forces a render before imageData can arrive in the same batch
              flushSync(() => setIsGeneratingImage(true));
            }
            if (data.imageData) {
              setIsGeneratingImage(false);
              const { b64, mimeType } = data.imageData as { b64: string; mimeType: string };
              setStreamingImages((prev) => [...prev, { b64, mimeType }]);
            }
            if (data.fileData) {
              const { filename, b64, mimeType } = data.fileData as { filename: string; b64: string; mimeType: string };
              setStreamingFiles((prev) => [...prev, { filename, b64, mimeType }]);
            }
            if (data.sources) {
              setStreamingSources(data.sources as Array<{ url: string; title: string }>);
            }
            if (data.error) {
              charQueueRef.current += `Sorry, something went wrong: ${data.error}`;
              done = true;
            }
            if (data.titleUpdate) setPendingTitle(data.titleUpdate as string);
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
        const tid = finalizeTargetRef.current;
        if (tid) {
          queryClient.invalidateQueries({ queryKey: getListCortexMessagesQueryKey(tid) });
          queryClient.invalidateQueries({ queryKey: getListCortexConversationsQueryKey() });
        }
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── Fix: don't show optimistic if server already has the user message ──────
  const showOptimistic = optimisticUserMessage && serverMessages.length <= optimisticBaseline;
  const showBubble = isStreaming || displayedContent.length > 0;

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
      <div className="max-w-4xl mx-auto">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((att, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-muted border border-border rounded-lg px-2.5 py-1 text-xs text-foreground">
                <Paperclip className="w-3 h-3 text-muted-foreground" />
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
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isThinking}
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,text/*,.js,.ts,.tsx,.jsx,.py,.java,.cpp,.cs,.go,.html,.css,.json,.md,.txt" onChange={handleFileUpload} />
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={() => fileInputRef.current?.click()} title="Attach file" type="button">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2.5">
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
        <p className="text-xs text-muted-foreground text-center mt-2">
          {isStreaming ? "Click stop to cancel" : "Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );

  if (!conversationId) {
    return (
      <div className="flex-1 flex flex-col h-full bg-background">
        <div className="text-center px-8 pt-10 pb-0">
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Cortex</h1>
          <p className="text-muted-foreground text-base mt-2">Your intelligent AI assistant — ask me anything.</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-2xl font-semibold text-foreground">
            {user ? `Hello, ${user.username}! How can I help?` : "Hello! How can I help you today?"}
          </p>
        </div>
        {inputBar("Ask Cortex anything...")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
      <div className="h-14 border-b flex items-center px-6 bg-card shrink-0">
        <div className="flex flex-col">
          <span className="font-semibold text-sm">{conversation?.title ?? "Loading..."}</span>
          <span className="text-xs text-muted-foreground">General AI</span>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto p-6" style={{ scrollBehavior: "smooth" }}>
          <div className="max-w-4xl mx-auto space-y-6 pb-4">
            {serverMessages.map((msg) => (
              <MessageBubble key={msg.id} role={msg.role as "user" | "assistant"} content={msg.content} />
            ))}
            {showOptimistic && (
              <MessageBubble role="user" content={optimisticUserMessage!} />
            )}
            {isThinking && <AIThinkingRow text="Thinking" />}
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

      {inputBar("Ask Cortex anything...")}
    </div>
  );
}
