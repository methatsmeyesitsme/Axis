import { pgTable, serial, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

// A Forge "app" is just a conversation with source="forge" — the conversation IS the app.
// These tables hang off conversations.id (referred to here as appId for clarity) and only
// come into use starting in later Forge phases (tool execution, run/preview, accounts).

export const forgeAppFiles = pgTable("forge_app_files", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Simple key/value storage scoped per app, optionally per end-user of that app.
export const forgeAppData = pgTable("forge_app_data", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  ownerEndUserId: integer("owner_end_user_id"),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Registry of real structured tables an app has defined via create_table.
export const forgeAppTables = pgTable("forge_app_tables", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  columns: jsonb("columns").notNull(), // e.g. [{ name: "title", type: "text" }, ...]
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Actual rows for those structured tables — generic JSONB row storage keyed by tableId,
// so we don't need to dynamically CREATE TABLE per generated app table.
export const forgeAppTableRows = pgTable("forge_app_table_rows", {
  id: serial("id").primaryKey(),
  tableId: integer("table_id")
    .notNull()
    .references(() => forgeAppTables.id, { onDelete: "cascade" }),
  ownerEndUserId: integer("owner_end_user_id"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// End users of a *generated app* (not Axis accounts) — scoped per app.
export const forgeAppEndUsers = pgTable("forge_app_end_users", {
  id: serial("id").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const forgeAppSessions = pgTable("forge_app_sessions", {
  token: text("token").primaryKey(),
  appId: integer("app_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  endUserId: integer("end_user_id")
    .notNull()
    .references(() => forgeAppEndUsers.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const insertForgeAppFileSchema = createInsertSchema(forgeAppFiles).omit({ id: true, updatedAt: true });
export const insertForgeAppDataSchema = createInsertSchema(forgeAppData).omit({ id: true, updatedAt: true });
export const insertForgeAppTableSchema = createInsertSchema(forgeAppTables).omit({ id: true, createdAt: true });
export const insertForgeAppTableRowSchema = createInsertSchema(forgeAppTableRows).omit({ id: true, createdAt: true, updatedAt: true });
export const insertForgeAppEndUserSchema = createInsertSchema(forgeAppEndUsers).omit({ id: true, createdAt: true });

export type ForgeAppFile = typeof forgeAppFiles.$inferSelect;
export type ForgeAppData = typeof forgeAppData.$inferSelect;
export type ForgeAppTable = typeof forgeAppTables.$inferSelect;
export type ForgeAppTableRow = typeof forgeAppTableRows.$inferSelect;
export type ForgeAppEndUser = typeof forgeAppEndUsers.$inferSelect;
export type ForgeAppSession = typeof forgeAppSessions.$inferSelect;
export type InsertForgeAppFile = z.infer<typeof insertForgeAppFileSchema>;
export type InsertForgeAppData = z.infer<typeof insertForgeAppDataSchema>;
export type InsertForgeAppTable = z.infer<typeof insertForgeAppTableSchema>;
export type InsertForgeAppTableRow = z.infer<typeof insertForgeAppTableRowSchema>;
export type InsertForgeAppEndUser = z.infer<typeof insertForgeAppEndUserSchema>;
