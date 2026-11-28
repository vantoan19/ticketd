import type { GithubRepository } from "@/lib/api/github";

export function repositoryName(repository: string) {
  return repository.replace(/^github\.com\//i, "");
}

export function lastGithubRefresh(repositories: readonly GithubRepository[]) {
  return repositories.reduce<string | null>(
    (latest, { last_refreshed_at: timestamp }) => {
      if (timestamp && (!latest || Date.parse(timestamp) > Date.parse(latest)))
        return timestamp;
      return latest;
    },
    null,
  );
}
