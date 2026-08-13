import type { FunctionDeclaration } from "@google/genai";
import { getUserGithubConnection, decryptToken } from "./github";

const GITHUB_API = "https://api.github.com";

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Axis" };
}

export const githubToolDeclarations: FunctionDeclaration[] = [
  {
    name: "github_list_files",
    description: "List files and folders at a path in the connected GitHub repo (root if path is omitted).",
    parametersJsonSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, e.g. 'src' — omit or use '' for the repo root" } },
    },
  },
  {
    name: "github_read_file",
    description: "Read a file's full contents from the connected GitHub repo.",
    parametersJsonSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path, e.g. 'src/index.ts'" } },
      required: ["path"],
    },
  },
  {
    name: "github_write_file",
    description: "Create or update a file in the connected GitHub repo. Commits directly to the selected branch.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. 'src/index.ts'" },
        content: { type: "string", description: "Full new file content" },
        commitMessage: { type: "string", description: "Short commit message describing the change" },
      },
      required: ["path", "content", "commitMessage"],
    },
  },
];

export async function isGithubReady(userId: number): Promise<boolean> {
  const conn = await getUserGithubConnection(userId);
  return !!(conn && conn.selectedOwner && conn.selectedRepo);
}

export async function executeGithubTool(
  userId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ output?: unknown; error?: string }> {
  const conn = await getUserGithubConnection(userId);
  if (!conn || !conn.selectedOwner || !conn.selectedRepo) {
    return { error: "No GitHub repository is connected/selected. Ask the person to connect GitHub and pick a repo in Settings." };
  }

  const token = decryptToken(conn.encryptedAccessToken);
  const owner = conn.selectedOwner;
  const repo = conn.selectedRepo;
  const branch = conn.selectedBranch ?? "main";

  try {
    switch (name) {
      case "github_list_files": {
        const path = String(args.path ?? "").replace(/^\/+/, "");
        const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
        const res = await fetch(url, { headers: authHeaders(token) });
        if (!res.ok) return { error: `GitHub API error: ${res.status} ${res.statusText}` };
        const data = (await res.json()) as unknown;
        const items = Array.isArray(data) ? data : [data];
        return {
          output: items.map((i) => {
            const entry = i as { name?: string; path?: string; type?: string };
            return { name: entry.name, path: entry.path, type: entry.type };
          }),
        };
      }
      case "github_read_file": {
        const path = String(args.path ?? "").replace(/^\/+/, "");
        if (!path) return { error: "path is required" };
        const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
        const res = await fetch(url, { headers: authHeaders(token) });
        if (!res.ok) return { error: `GitHub API error: ${res.status} ${res.statusText}` };
        const data = (await res.json()) as { content?: string };
        if (!data.content) return { error: "That path is not a readable file (it may be a directory or empty)" };
        return { output: Buffer.from(data.content, "base64").toString("utf8") };
      }
      case "github_write_file": {
        const path = String(args.path ?? "").replace(/^\/+/, "");
        const content = String(args.content ?? "");
        const commitMessage = String(args.commitMessage ?? "Update via Axis");
        if (!path) return { error: "path is required" };

        // Updating an existing file requires its current sha; creating a new
        // one must NOT include a sha, so look it up first (404 = new file).
        let sha: string | undefined;
        const existingRes = await fetch(
          `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
          { headers: authHeaders(token) },
        );
        if (existingRes.ok) {
          const existing = (await existingRes.json()) as { sha?: string };
          sha = existing.sha;
        }

        const putRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
          method: "PUT",
          headers: { ...authHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify({
            message: commitMessage,
            content: Buffer.from(content, "utf8").toString("base64"),
            branch,
            ...(sha ? { sha } : {}),
          }),
        });
        if (!putRes.ok) {
          const errBody = await putRes.text();
          return { error: `GitHub API error: ${putRes.status} ${putRes.statusText} — ${errBody.slice(0, 300)}` };
        }
        return { output: `Committed ${path} to ${owner}/${repo}@${branch}` };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
