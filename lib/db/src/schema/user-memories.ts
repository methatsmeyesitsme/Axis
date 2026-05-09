import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const userMemories = pgTable("user_memories", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type UserMemory = typeof userMemories.$inferSelect;
