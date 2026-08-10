import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const githubConnections = pgTable("github_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  githubUserId: text("github_user_id").notNull(),
  login: text("login").notNull(),
  avatarUrl: text("avatar_url"),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  selectedOwner: text("selected_owner"),
  selectedRepo: text("selected_repo"),
  selectedBranch: text("selected_branch"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GithubConnection = typeof githubConnections.$inferSelect;