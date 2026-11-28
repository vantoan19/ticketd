import { Channel } from "@tauri-apps/api/core";
import { z } from "zod";
import { invoke, structured } from "./bridge-failure";
import { previewSchema } from "./sources";

const hostSchema = z.object({
  host: z.string(),
  state: z.enum(["connected", "not_installed", "not_signed_in", "unavailable"]),
  login: z.string().nullable(),
  message: z.string().nullable(),
});

const repositoryRuleSchema = z.object({
  repository: z.string(),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
});

const repositorySchema = repositoryRuleSchema.extend({
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  project_login: z.string().nullable(),
  tracked_tickets: z.number(),
  last_refreshed_at: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const migrationNoticeSchema = z.object({
  repository: z.string(),
  message: z.string(),
});

const integrationSchema = z.object({
  id: z.literal("github"),
  hosts: z.array(hostSchema),
  repositories: z.array(repositorySchema),
  migration_notices: z.array(migrationNoticeSchema),
});

export type GithubHost = z.infer<typeof hostSchema>;
export type GithubRepositoryRule = z.infer<typeof repositoryRuleSchema>;
export type GithubRepository = z.infer<typeof repositorySchema>;
export type GithubMigrationNotice = z.infer<typeof migrationNoticeSchema>;
export type GithubIntegration = z.infer<typeof integrationSchema>;

export async function getGithubIntegration() {
  return integrationSchema.parse(await structured(invoke("get_github_integration")));
}

export async function previewGithubRepository(rule: GithubRepositoryRule) {
  return previewSchema.parse(await structured(invoke("preview_github_repository", { rule })));
}

export async function saveGithubRepository(rule: GithubRepositoryRule) {
  return repositorySchema.parse(await structured(invoke("save_github_repository", { rule })));
}

export async function removeGithubRepository(repository: string) {
  await structured(invoke("remove_github_repository", { repository }));
}

export async function setGithubProjectLogin(projectId: string, host: string, login: string | null) {
  await structured(invoke("set_github_project_login", { projectId, host, login }));
}

export async function signInGithub(host: string, onCode: (code: string) => void) {
  const codes = new Channel<unknown>();
  codes.onmessage = (value) => onCode(z.string().parse(value));
  return hostSchema.parse(await structured(invoke("start_github_sign_in", { host, codes })));
}

export async function cancelGithubSignIn(host: string) {
  await structured(invoke("cancel_github_sign_in", { host }));
}
