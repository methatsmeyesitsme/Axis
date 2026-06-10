import aiLogo from "/ai-logo.png";

export function AIAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-white border border-border/50 flex items-center justify-center shrink-0 overflow-hidden shadow-sm">
      <img
        src={aiLogo}
        alt="AI"
        className="w-6 h-6 object-contain"
        style={{ mixBlendMode: "multiply" }}
      />
    </div>
  );
}

export function ShimmerLabel({ text }: { text: string }) {
  return <span className="text-sm font-medium shimmer-text">{text}</span>;
}

export function AIThinkingRow({ text }: { text: string }) {
  return (
    <div
      className="flex items-center gap-3"
      style={{ animation: "fadeSlideIn 0.18s ease-out both" }}
    >
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <AIAvatar />
      <div className="pt-0.5">
        <ShimmerLabel text={text} />
      </div>
    </div>
  );
}
