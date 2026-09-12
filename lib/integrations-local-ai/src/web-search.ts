export type LocalSearchSource = {
  title: string;
  url: string;
  snippet: string;
};

export type LocalSearchResult = {
  query: string;
  sources: LocalSearchSource[];
};

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return null;
  }
}

function parseHtmlResults(html: string): LocalSearchSource[] {
  const sources: LocalSearchSource[] = [];
  const resultPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi;

  for (const match of html.matchAll(resultPattern)) {
    const url = normalizeUrl(match[1]);
    const title = decodeHtml(match[2]);
    if (!url || !title) continue;
    sources.push({ title, url, snippet: decodeHtml(match[3] ?? "") });
    if (sources.length >= 5) break;
  }
  return sources;
}

function parseInstantAnswers(data: unknown): LocalSearchSource[] {
  const sources: LocalSearchSource[] = [];
  const visit = (value: unknown): void => {
    if (sources.length >= 5 || !value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.FirstURL === "string" && typeof record.Text === "string") {
      sources.push({
        title: record.Name ? String(record.Name) : record.Text.split(" - ")[0],
        url: record.FirstURL,
        snippet: record.Text,
      });
    }
    if (Array.isArray(record.Topics)) record.Topics.forEach(visit);
    if (Array.isArray(record.RelatedTopics)) record.RelatedTopics.forEach(visit);
  };
  visit(data);
  return sources;
}

/**
 * Keyless web search for the local model. DuckDuckGo's public endpoints are
 * best-effort and intentionally return sources, not an opaque answer.
 */
export async function localWebSearch(query: string): Promise<LocalSearchResult> {
  const trimmed = query.trim().slice(0, 240);
  if (!trimmed) return { query: "", sources: [] };

  const instantUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(trimmed)}&format=json&no_html=1&skip_disambig=1`;
  const instantResponse = await fetch(instantUrl, {
    headers: { "User-Agent": "Axis local search (free)" },
  });
  let sources: LocalSearchSource[] = [];
  if (instantResponse.ok) {
    sources = parseInstantAnswers(await instantResponse.json());
  }

  if (sources.length === 0) {
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const htmlResponse = await fetch(htmlUrl, {
      headers: { "User-Agent": "Axis local search (free)" },
    });
    if (!htmlResponse.ok) throw new Error(`Web search unavailable (${htmlResponse.status})`);
    sources = parseHtmlResults(await htmlResponse.text());
  }

  return { query: trimmed, sources };
}