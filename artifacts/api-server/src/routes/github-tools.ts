import type { FunctionDeclaration } from "@google/genai";
import { getUserGithubConnection, decryptToken } from "./github";

const GITHUB_API = "https://api.github.com";

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Axis",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
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

/** List files from a public (or private with token) repo without requiring Settings connection. */
export async function listGithubRepoPublic(
  owner: string,
  repo: string,
  path = "",
  branch = "main",
  token?: string,
): Promise<{ output?: unknown; error?: string }> {
  try {
    const cleanPath = path.replace(/^\/+/, "");
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
    let res = await fetch(url, { headers: authHeaders(token) });
    // Fallback to master if main 404s
    if (!res.ok && branch === "main") {
      const alt = `${GITHUB_API}/repos/${owner}/${repo}/contents/${cleanPath}?ref=master`;
      res = await fetch(alt, { headers: authHeaders(token) });
    }
    if (!res.ok) return { error: `GitHub API error: ${res.status} ${res.statusText}` };
    const data = (await res.json()) as unknown;
    const items = Array.isArray(data) ? data : [data];
    return {
      output: items.map((i) => {
        const entry = i as { name?: string; path?: string; type?: string };
        return { name: entry.name, path: entry.path, type: entry.type };
      }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read a file from a public (or private with token) repo. */
export async function readGithubFilePublic(
  owner: string,
  repo: string,
  path: string,
  branch = "main",
  token?: string,
): Promise<{ output?: unknown; error?: string }> {
  try {
    const cleanPath = path.replace(/^\/+/, "");
    if (!cleanPath) return { error: "path is required" };
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
    let res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok && branch === "main") {
      const alt = `${GITHUB_API}/repos/${owner}/${repo}/contents/${cleanPath}?ref=master`;
      res = await fetch(alt, { headers: authHeaders(token) });
    }
    if (!res.ok) return { error: `GitHub API error: ${res.status} ${res.statusText}` };
    const data = (await res.json()) as { content?: string; encoding?: string; type?: string };
    if (data.type === "dir") return { error: "That path is a directory, not a file" };
    if (!data.content) return { error: "That path is not a readable file" };
    return { output: Buffer.from(data.content, "base64").toString("utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseOwnerRepo(text: string): { owner: string; repo: string } | null {
  const m = text.match(/\b([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})\b/);
  if (!m) return null;
  // Avoid matching things like text/plain
  const owner = m[1];
  const repo = m[2];
  if (/^(text|application|image|audio|video)$/i.test(owner)) return null;
  return { owner, repo };
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
        return listGithubRepoPublic(owner, repo, String(args.path ?? ""), branch, token);
      }
      case "github_read_file": {
        return readGithubFilePublic(owner, repo, String(args.path ?? ""), branch, token);
      }
      case "github_write_file": {
        const path = String(args.path ?? "").replace(/^\/+/, "");
        const content = String(args.content ?? "");
        const commitMessage = String(args.commitMessage ?? "Update via Axis");
        if (!path) return { error: "path is required" };

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
