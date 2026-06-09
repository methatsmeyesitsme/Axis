import { useState } from "react";
import { Check, Copy, Download, User, Bot, FileText, FileSpreadsheet, FileJson, File } from "lucide-react";
import { Button } from "@/components/ui/button";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isThinking?: boolean;
  streamingImages?: Array<{ b64: string; mimeType: string }>;
  streamingFiles?: Array<{ filename: string; b64: string; mimeType: string }>;
  sources?: Array<{ url: string; title: string }>;
}

interface ParsedContent {
  text: string;
  images: Array<{ b64: string; mimeType: string }>;
  files: Array<{ filename: string; b64: string; mimeType: string }>;
}

function parseMessageContent(raw: string): ParsedContent {
  const images: Array<{ b64: string; mimeType: string }> = [];
  const files: Array<{ filename: string; b64: string; mimeType: string }> = [];
  const text = raw
    .replace(/\[IMAGE:([^|]+)\|([^\]]+)\]/g, (_, mimeType: string, b64: string) => {
      images.push({ mimeType, b64 });
      return "";
    })
    .replace(/\[FILEDATA:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g, (_, filename: string, mimeType: string, b64: string) => {
      files.push({ filename: filename.trim(), mimeType: mimeType.trim(), b64: b64.trim() });
      return "";
    })
    .replace(/\[IMAGE_PROMPT:[^\]]*\]/gi, "")
    .trimEnd();
  return { text, images, files };
}

function getFileIcon(ext: string) {
  if (["csv", "tsv"].includes(ext)) return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
  if (["json", "xml", "yaml", "yml"].includes(ext)) return <FileJson className="w-5 h-5 text-blue-600" />;
  if (["txt", "md", "text"].includes(ext)) return <FileText className="w-5 h-5 text-gray-600" />;
  return <File className="w-5 h-5 text-primary" />;
}

function FileDownloadCard({ filename, b64, mimeType }: { filename: string; b64: string; mimeType: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";

  const handleDownload = () => {
    const dataUrl = `data:${mimeType};base64,${b64}`;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.click();
  };

  return (
    <div className="my-3 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/60 shadow-sm">
      {getFileIcon(ext)}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate text-foreground">{filename}</p>
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{ext} file</p>
      </div>
      <Button size="sm" variant="outline" onClick={handleDownload} className="shrink-0 gap-1.5 text-xs font-medium">
        <Download className="w-3.5 h-3.5" />
        Download
      </Button>
    </div>
  );
}

function ImageBlock({ b64, mimeType }: { b64: string; mimeType: string }) {
  const [copied, setCopied] = useState(false);
  const dataUrl = `data:${mimeType};base64,${b64}`;
  const ext = mimeType.split("/")[1] ?? "png";

  const handleCopy = async () => {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
    } catch {
      await navigator.clipboard.writeText(dataUrl);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `codegen-image.${ext}`;
    a.click();
  };

  return (
    <div className="relative inline-block my-3 rounded-xl overflow-hidden shadow-md group">
      <img src={dataUrl} alt="AI generated" className="block max-w-full rounded-xl" style={{ maxWidth: 480 }} />
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy image"
          className="h-8 w-8 bg-black/50 hover:bg-black/70 text-white border-0 rounded-lg backdrop-blur-sm">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={handleDownload} title="Download image"
          className="h-8 w-8 bg-black/50 hover:bg-black/70 text-white border-0 rounded-lg backdrop-blur-sm">
          <Download className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const extMap: Record<string, string> = {
      javascript: "js", typescript: "ts", python: "py", java: "java",
      cpp: "cpp", csharp: "cs", go: "go", rust: "rs", php: "php",
      ruby: "rb", swift: "swift", kotlin: "kt", dart: "dart", lua: "lua",
      luau: "luau", sql: "sql", bash: "sh", shell: "sh", r: "r",
      html: "html", css: "css", json: "json", xml: "xml", yaml: "yaml",
      yml: "yml", markdown: "md", md: "md", toml: "toml", csv: "csv",
      text: "txt", txt: "txt", plaintext: "txt", plain: "txt",
      tsx: "tsx", jsx: "jsx", scss: "scss", sass: "sass", less: "less",
      graphql: "graphql",
    };
    const lang = language?.toLowerCase() ?? "";
    const ext = extMap[lang] ?? "txt";
    const mimeType = lang === "csv" ? "text/csv" : lang === "json" ? "application/json" : "text/plain";
    const blob = new Blob([code], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codegen-snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const displayLang = language || "code";

  return (
    <div className="my-4 rounded-xl border border-gray-700 shadow-md">
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 bg-[#1a1f2e] border-b border-gray-700 rounded-t-xl">
        <span className="text-xs font-mono text-gray-400">{displayLang}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10"
            onClick={handleDownload} title="Download file">
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10"
            onClick={handleCopy} title="Copy">
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>
      <div className="rounded-b-xl overflow-hidden">
        <SyntaxHighlighter language={displayLang} style={atomOneDark}
          customStyle={{ margin: 0, padding: "1rem", fontSize: "0.8125rem", lineHeight: "1.6", background: "#1E293B" }}
          showLineNumbers wrapLongLines={false}>
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-sm text-muted-foreground italic">Thinking</span>
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function renderContent(text: string): React.ReactNode[] {
  if (!text) return [];

  // Split on code blocks AND [FILE: ...] markers
  const parts = text.split(/(```[\s\S]*?(?:```|$)|\[FILE:\s*[^\]\n]+\])/g);
  const result: React.ReactNode[] = [];
  let pendingFilename: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // [FILE: filename.ext] marker — remember for next code block
    const fileMarker = part.match(/^\[FILE:\s*([^\]\n]+)\]$/);
    if (fileMarker) {
      pendingFilename = fileMarker[1].trim();
      continue;
    }

    // Code block
    if (part.startsWith("```")) {
      const closed = part.endsWith("```") && part.length > 3;
      const inner = closed ? part.slice(3, -3) : part.slice(3);
      const newlineIdx = inner.indexOf("\n");
      const lang = newlineIdx > -1 ? inner.slice(0, newlineIdx).trim() : "";
      const code = newlineIdx > -1 ? inner.slice(newlineIdx + 1) : inner;

      if (pendingFilename) {
        // Render as file download card (inline, from streaming text)
        const filename = pendingFilename;
        pendingFilename = null;
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeType: Record<string, string> = {
          csv: "text/csv", txt: "text/plain", text: "text/plain",
          json: "application/json", xml: "application/xml",
        };
        const mime = mimeType[ext] ?? "text/plain";
        const handleDownload = () => {
          const blob = new Blob([code.trimEnd()], { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        };
        result.push(
          <div key={i} className="my-3 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/60 shadow-sm">
            {getFileIcon(ext)}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate text-foreground">{filename}</p>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{ext} file · ready to download</p>
            </div>
            <Button size="sm" variant="outline" onClick={handleDownload} className="shrink-0 gap-1.5 text-xs font-medium">
              <Download className="w-3.5 h-3.5" />
              Download
            </Button>
          </div>
        );
      } else {
        pendingFilename = null;
        result.push(<CodeBlock key={i} language={lang} code={code.trimEnd()} />);
      }
      continue;
    }

    pendingFilename = null;

    if (!part.trim()) continue;

    const lines = part.split("\n");
    result.push(
      <div key={i} className="space-y-1.5">
        {lines.map((line, li) => {
          if (!line.trim() && li > 0) return <div key={li} className="h-1" />;
          const segments = line.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
          return (
            <p key={li} className="leading-relaxed">
              {segments.map((seg, j) => {
                if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 2)
                  return <code key={j} className="bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono text-[0.8em]">{seg.slice(1, -1)}</code>;
                if (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4)
                  return <strong key={j} className="font-semibold text-foreground">{seg.slice(2, -2)}</strong>;
                if (seg.startsWith("*") && seg.endsWith("*") && seg.length > 2)
                  return <em key={j}>{seg.slice(1, -1)}</em>;
                return <span key={j}>{seg}</span>;
              })}
            </p>
          );
        })}
      </div>
    );
  }

  return result;
}

function SourcesList({ sources }: { sources: Array<{ url: string; title: string }> }) {
  if (!sources.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Sources</p>
      <div className="flex flex-col gap-1">
        {sources.map((s, i) => (
          <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-primary hover:underline truncate block max-w-full">
            {s.title || s.url}
          </a>
        ))}
      </div>
    </div>
  );
}

export default function MessageBubble({
  role, content, isStreaming, isThinking, streamingImages, streamingFiles, sources,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const { text, images: parsedImages, files: parsedFiles } = parseMessageContent(content);

  const allImages = parsedImages.length > 0 ? parsedImages : (streamingImages ?? []);
  const allFiles = parsedFiles.length > 0 ? parsedFiles : (streamingFiles ?? []);

  return (
    <div className={`flex gap-3 w-full ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}

      <div className={`max-w-[85%] rounded-2xl px-5 py-4 ${
        isUser
          ? "bg-primary text-primary-foreground rounded-tr-sm shadow-sm"
          : "bg-card border border-border text-card-foreground rounded-tl-sm shadow-sm"
      }`}>
        <div className="text-[14.5px]">
          {isThinking && !content ? (
            <ThinkingIndicator />
          ) : (
            <>
              {renderContent(text)}
              {allImages.map((img, i) => (
                <ImageBlock key={i} b64={img.b64} mimeType={img.mimeType} />
              ))}
              {allFiles.map((f, i) => (
                <FileDownloadCard key={i} filename={f.filename} b64={f.b64} mimeType={f.mimeType} />
              ))}
              {sources && <SourcesList sources={sources} />}
              {isStreaming && allImages.length === 0 && (
                <span className="inline-block w-0.5 h-4 ml-0.5 bg-primary animate-pulse align-middle rounded-full" />
              )}
            </>
          )}
        </div>
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
          <User className="w-4 h-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
