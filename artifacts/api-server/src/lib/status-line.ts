/** Short tool status line (max 5 words). */
export function toolStatusSummary(
  name: string,
  args: Record<string, unknown> = {},
  phase: "start" | "done" | "error" = "start",
): string {
  const path = String(args.path ?? args.file ?? args.filename ?? "").replace(/^\/+/, "");
  const shortPath = path ? path.split("/").pop() || path : "";

  let words: string[] = ["Working"];

  if (name === "github_list_files") {
    words = path ? ["Listing", shortPath, "files"] : ["Listing", "repo", "files"];
  } else if (name === "github_read_file") {
    words = shortPath ? ["Reading", shortPath] : ["Reading", "file"];
  } else if (name === "github_write_file") {
    if (shortPath) {
      words = phase === "done" ? ["Saved", shortPath] : ["Editing", shortPath];
    } else {
      words = phase === "done" ? ["Saved", "file"] : ["Writing", "file"];
    }
  } else if (name === "web_search") {
    words = phase === "done" ? ["Finished", "web", "search"] : ["Searching", "the", "web"];
  } else if (name === "run_preview") {
    words = phase === "done" ? ["Preview", "ready"] : ["Running", "preview"];
  } else if (name === "image_gen") {
    words = phase === "done" ? ["Image", "ready"] : ["Drawing", "your", "image"];
  } else {
    const label = name.replace(/^github_/, "").replace(/_/g, " ");
    words = phase === "done" ? ["Done", label] : ["Using", label];
  }

  if (phase === "error") {
    words = ["Failed", ...words.slice(0, 4)];
  }

  return words.filter(Boolean).slice(0, 5).join(" ");
}
