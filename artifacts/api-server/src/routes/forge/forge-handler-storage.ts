import { db, forgeAppFiles } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// Backend handlers are stored as "files" with a reserved path convention so we
// don't need a separate DB table: "__handler__:<METHOD> <route>".
export function handlerFilePath(method: string, route: string): string {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  return `__handler__:${method.toUpperCase()} ${normalizedRoute}`;
}

export async function saveBackendHandler(appId: number, method: string, route: string, code: string): Promise<void> {
  const path = handlerFilePath(method, route);
  const [existing] = await db.select().from(forgeAppFiles).where(and(eq(forgeAppFiles.appId, appId), eq(forgeAppFiles.path, path)));
  if (existing) {
    await db.update(forgeAppFiles).set({ content: code, updatedAt: new Date() }).where(eq(forgeAppFiles.id, existing.id));
  } else {
    await db.insert(forgeAppFiles).values({ appId, path, content: code });
  }
}
