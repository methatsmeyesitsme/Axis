/**
 * Free image generation via Pollinations (no API key).
 * This is NOT the local Qwen text model — text models cannot output pixels.
 */

export function wantsImageGeneration(text: string): boolean {
  return /\b(draw|generate|create|make|paint|sketch|illustrate|render)\b[\s\S]{0,40}\b(image|picture|photo|art|illustration|logo|icon)\b|\b(image|picture|photo) of\b|\bgenerate an? image\b/i.test(
    text,
  );
}

/** Turn a user message into a short image prompt. */
export function extractImagePrompt(userText: string): string {
  let t = userText.trim();
  t = t
    .replace(
      /^(please\s+)?(can you\s+)?(draw|generate|create|make|paint|sketch|illustrate|render)\s+(me\s+)?(an?\s+)?(image|picture|photo|art|illustration)\s+(of\s+)?/i,
      "",
    )
    .replace(/^(please\s+)?(an?\s+)?(image|picture|photo)\s+of\s+/i, "")
    .trim();
  if (!t || t.length < 3) t = userText.trim();
  return t.slice(0, 400);
}

export async function localGenerateImage(
  prompt: string,
): Promise<{ b64: string; mimeType: string }> {
  const encoded = encodeURIComponent(prompt.slice(0, 400));
  // Pollinations public endpoint — free, no key
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${Date.now() % 1_000_000}`;

  const res = await fetch(url, {
    headers: { Accept: "image/*", "User-Agent": "Axis" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Image generation failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("Image generation returned empty data");
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  return { b64: buf.toString("base64"), mimeType };
}
