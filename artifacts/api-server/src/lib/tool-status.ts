/**
 * Build a short status line for tool activity (max 5 words).
 */
export function toolStatusSummary(
  name: string,
  args: Record<string, unknown> = {},
  phase: "start" | "done" | "error" = "start",
): string {
  const path = String(args.path ?? args.file ?? args.filename ?? "").replace(/^\/+/, "");
  const shortPath = path ? path.split("/").pop() || path : "";

  let words: string[] = ["Working"];

  switch (name) {
    case "github_list_files":
      words = path ? ["Listing", shortPath, "files"] : ["Listing", "repo", "files"];
      break;
    case "github_read_file":
      words = shortPath ? ["Reading", shortPath] : ["Reading", "file"];
      break;
    case "github_write_file":
      if (shortPath) {
        words = phase === "done" ? ["Saved", shortPath] : ["Editing", shortPath];
      } else {
        words = phase === "done" ? ["Saved", "file"] : ["Writing", "file"];
      }
      break;
    case "web_search":
      words = phase === "done" ? ["Finished", "web", "search"] : ["Searching", "the", "web"];
      break;
    case "run_preview":
      words = phase === "done" ? ["Preview", "ready"] : ["Running", "preview"];
      break;
    case "image_gen":
      words = phase === "done" ? ["Image", "ready"] : ["Drawing", "your", "image"];
      break;
    default: {
      const label = name.replace(/^github_/, "").replace(/_/g, " ");
      words = phase === "done" ? ["Done", label] : ["Using", label];
      break;
    }
  }

  if (phase === "error") {
    words = ["Failed", ...words.slice(0, 4)];
  }

  return words.filter(Boolean).slice(0, 5).join(" ");
}
