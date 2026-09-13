import { useState } from "react";
import { Check, Copy, Download, User, FileText, FileSpreadsheet, FileJson, File, ChevronDown, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { AIAvatar } from "./AIStatusLabel";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  isGeneratingImage?: boolean;
  streamingImages?: Array<{ b64: string; mimeType: string }>;
  streamingFiles?: Array<{ filename: string; b64: string; mimeType: string }>;
  sources?: Array<{ url: string; title: string }>;
}

interface ParsedContent {
  text: string;
  images: Array<{ b64: string; mimeType: string }>;
  files: Array<{ filename: string; b64: string; mimeType: string }>;
}

function stripImagePromptTag(s: string): string {
  // Strip complete [IMAGE_PROMPT...] or any text from [IMAGE_PROMPT onwards
  const idx = s.search(/\[IMAGE_PROMPT/i);
  if (idx >= 0) return s.slice(0, idx);

  // Strip partial build-up at end of string ONLY if it's a prefix of "IMAGE_PROMPT"
  // e.g. "[", "[I", "[IM", "[IMA", "[IMAGE_PROMPT" — but NOT "[TODO", "[LIST", etc.
  const partial = s.match(/\[([A-Z_]*)$/i);
  if (partial) {
    const prefix = partial[1].toUpperCase();
    if ("IMAGE_PROMPT".startsWith(prefix)) {
      return s.slice(0, partial.index);
    }
  }
  return s;
}

function parseMessageContent(raw: string): ParsedContent {
  const images: Array<{ b64: string; mimeType: string }> = [];
  const files: Array<{ filename: string; b64: string; mimeType: string }> = [];
  const stripped = raw
    .replace(/\[IMAGE:([^|]+)\|([^\]]+)\]/g, (_, mimeType: string, b64: string) => {
      images.push({ mimeType, b64 });
      return "";
    })
    .replace(/\[FILEDATA:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g, (_, filename: string, mimeType: string, b64: string) => {
      files.push({ filename: filename.trim(), mimeType: mimeType.trim(), b64: b64.trim() });
      return "";
    });
  const text = stripImagePromptTag(stripped).trimEnd();
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
    const a = document.createElement("a");
    a.href = `data:${mimeType};base64,${b64}`;
    a.download = filename;
    a.click();
  };
  return (
    <div className="my-3 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/60 shadow-sm transition-all hover:shadow-md">
      {getFileIcon(ext)}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate text-foreground">{filename}</p>
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{ext} file</p>
      </div>
      <Button size="sm" variant="outline" onClick={handleDownload} className="shrink-0 gap-1.5 text-xs font-medium transition-all hover:scale-105">
        <Download className="w-3.5 h-3.5" />
        Download
      </Button>
    </div>
  );
}

function ImageBlock({ b64, mimeType, maxWidth = 240 }: { b64: string; mimeType: string; maxWidth?: number }) {
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
    <div
      className="relative inline-block my-3 rounded-xl overflow-hidden shadow-md group"
      style={{ opacity: loaded ? 1 : 0, transition: "opacity 0.4s ease" }}
    >
      <img
        src={dataUrl}
        alt="AI generated"
        className="block max-w-full rounded-xl"
        style={{ maxWidth }}
        onLoad={() => setLoaded(true)}
      />
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
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

function CreatingImagePlaceholder() {
  return (
    <div
      className="my-3 rounded-2xl bg-muted/70 border border-border flex items-start p-4"
      style={{ width: 130, height: 130, animation: "shimmer-pulse 1.8s ease-in-out infinite" }}
    >
      <span className="text-sm font-medium shimmer-text">Creating</span>
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
    <div className="my-4 rounded-xl border border-gray-700 shadow-md overflow-hidden">
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 bg-[#1a1f2e] border-b border-gray-700">
        <span className="text-xs font-mono text-gray-400">{displayLang}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            onClick={handleDownload} title="Download file">
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            onClick={handleCopy} title="Copy">
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>
      <div>
        <SyntaxHighlighter language={displayLang} style={atomOneDark}
          customStyle={{ margin: 0, padding: "1rem", fontSize: "0.8125rem", lineHeight: "1.6", background: "#1E293B" }}
          showLineNumbers wrapLongLines={false}>
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

function SourcesList({ sources }: { sources: Array<{ url: string; title: string }> }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Globe className="w-3.5 h-3.5 shrink-0" />
        <span>{sources.length} source{sources.length !== 1 ? "s" : ""}</span>
        <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <div
        className="overflow-hidden transition-all duration-200"
        style={{ maxHeight: open ? `${sources.length * 28}px` : "0px", opacity: open ? 1 : 0 }}
      >
        <div className="mt-2 flex flex-col gap-1">
          {sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
              className="text-xs text-primary hover:underline truncate block max-w-full transition-opacity hover:opacity-80">
              {s.title || s.url}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function renderContent(text: string): React.ReactNode[] {
  if (!text) return [];

  const parts = text.split(/(```[\s\S]*?(?:```|$)|\[FILE:\s*[^\]\n]+\])/g);
  const result: React.ReactNode[] = [];
  let pendingFilename: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    const fileMarker = part.match(/^\[FILE:\s*([^\]\n]+)\]$/);
    if (fileMarker) {
      pendingFilename = fileMarker[1].trim();
      continue;
    }

    if (part.startsWith("```")) {
      const closed = part.endsWith("```") && part.length > 3;
      const inner = closed ? part.slice(3, -3) : part.slice(3);
      const newlineIdx = inner.indexOf("\n");
      const lang = newlineIdx > -1 ? inner.slice(0, newlineIdx).trim() : "";
      const code = newlineIdx > -1 ? inner.slice(newlineIdx + 1) : inner;

      if (pendingFilename) {
        const filename = pendingFilename;
        pendingFilename = null;
        const ext = filename.split(".").pop()?.toLowerCase() ?? "txt";
        const mimeTypeMap: Record<string, string> = {
          csv: "text/csv", txt: "text/plain", text: "text/plain",
          json: "application/json", xml: "application/xml",
        };
        const mime = mimeTypeMap[ext] ?? "text/plain";
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
          <div key={i} className="my-3 flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-muted/60 shadow-sm hover:shadow-md transition-all">
            {getFileIcon(ext)}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate text-foreground">{filename}</p>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{ext} file · ready to download</p>
            </div>
            <Button size="sm" variant="outline" onClick={handleDownload} className="shrink-0 gap-1.5 text-xs font-medium hover:scale-105 transition-all">
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

function CopyMessageButton({ text, align }: { text: string; align: "left" | "right" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — fail quietly.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy message"
      className={`mt-1 flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors ${
        align === "right" ? "self-end mr-11" : "self-start ml-11"
      }`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function MessageBubble({
  role, content, isStreaming, isGeneratingImage,
  streamingImages, streamingFiles, sources,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const { text, images: parsedImages, files: parsedFiles } = parseMessageContent(content);

  const allImages = parsedImages.length > 0 ? parsedImages : (streamingImages ?? []);
  const allFiles = parsedFiles.length > 0 ? parsedFiles : (streamingFiles ?? []);

  return (
    <div className={`flex flex-col w-full ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`flex gap-3 w-full ${isUser ? "justify-end" : "justify-start"}`}
        style={{ animation: "fadeSlideIn 0.18s ease-out both" }}
      >
        <style>{`
          @keyframes fadeSlideIn {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {!isUser && <AIAvatar />}

        <div className={`max-w-[85%] rounded-2xl px-5 py-4 ${
          isUser
            ? "bg-primary text-primary-foreground rounded-tr-sm shadow-sm"
            : "bg-card border border-border text-card-foreground rounded-tl-sm shadow-sm"
        }`}>
          <div className="text-[14.5px]">
            {renderContent(text)}
            {allImages.map((img, i) => (
              <ImageBlock key={i} b64={img.b64} mimeType={img.mimeType} maxWidth={isUser ? 240 : undefined} />
            ))}
            {isGeneratingImage && <CreatingImagePlaceholder />}
            {allFiles.map((f, i) => (
              <FileDownloadCard key={i} filename={f.filename} b64={f.b64} mimeType={f.mimeType} />
            ))}
            {sources && <SourcesList sources={sources} />}
            {isStreaming && allImages.length === 0 && !isGeneratingImage && (
              <span className="inline-block w-0.5 h-4 ml-0.5 bg-primary animate-pulse align-middle rounded-full" />
            )}
          </div>
        </div>

        {isUser && (
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
        )}
      </div>

      {!isStreaming && text.trim() && (
        <CopyMessageButton text={text} align={isUser ? "right" : "left"} />
      )}
    </div>
  );
}
