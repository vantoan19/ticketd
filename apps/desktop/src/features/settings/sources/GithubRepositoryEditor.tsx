import { useId, useState, type RefObject } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import { GithubSignInRow } from "@/features/settings/sources/GithubSignInRow";
import { SchemaForm } from "@/features/settings/sources/SchemaForm";
import type { Draft } from "@/features/settings/sources/config-values";
import { SourcePreview } from "@/features/settings/sources/SourcePreview";
import { failureText } from "@/lib/api/describe-failure";
import {
  getGithubHostReadiness,
  previewGithubRepository,
  saveGithubRepository,
  type GithubHost,
  type GithubRepository,
} from "@/lib/api/github";
import {
  sourcesClient,
  type DiscoveryPreview,
  type SchemaField,
} from "@/lib/api/sources";

const repositoryField: SchemaField = {
  key: "repositories",
  label: "Repository",
  help: "Choose a repository or type owner/name and press Enter.",
  placeholder: "e.g. northwind/web",
  required: true,
  type: "multi_select",
  allow_custom: true,
  min_items: 1,
  max_items: 1,
  format: "owner_name",
  options: { source: "dynamic", depends_on: [] },
};
const filterFields: SchemaField[] = [
  {
    key: "assignee",
    label: "Assignee",
    help: "Leave empty for any assignee. Use @me for your GitHub login.",
    required: false,
    type: "text",
  },
  {
    key: "labels",
    label: "Labels",
    help: "Open issues must have every label you choose.",
    required: false,
    type: "multi_select",
    allow_custom: true,
    min_items: 0,
    max_items: 10,
    options: { source: "dynamic", depends_on: ["repositories"] },
  },
];
const addFields = [repositoryField, ...filterFields];

export function GithubRepositoryEditor({
  repository,
  initialRepository,
  knownRepositories,
  knownHosts = [],
  onCancel,
  onSaved,
  onSavingChange,
  returnFocus,
}: {
  repository?: GithubRepository;
  initialRepository?: string;
  knownRepositories: readonly GithubRepository[];
  knownHosts?: readonly GithubHost[];
  onCancel: () => void;
  onSaved: () => void;
  onSavingChange?: (saving: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const identity = repository?.repository ?? initialRepository;
  const parts = identity?.split("/") ?? [];
  const hostFromIdentity = parts.length === 3 ? parts.shift() : undefined;
  const [host, setHost] = useState(hostFromIdentity ?? "github.com");
  const [draft, setDraft] = useState<Draft>(() => ({
    repositories: identity ? [parts.join("/")] : [],
    assignee: repository?.assignee ?? "",
    labels: repository?.labels ?? [],
  }));
  const hostId = useId();
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [review, setReview] = useState<DiscoveryPreview | null>(null);
  const [failure, setFailure] = useState("");
  const [checkedHost, setCheckedHost] = useState<GithubHost | null>(null);
  const [checking, setChecking] = useState(false);
  const site = githubSite(host);
  const readiness =
    checkedHost?.host === site
      ? checkedHost
      : knownHosts.find(({ host }) => host === site);
  const signInRequired = !repository && readiness?.state !== "connected";
  const names = Array.isArray(draft.repositories) ? draft.repositories : [];
  const assignee =
    typeof draft.assignee === "string" ? draft.assignee.trim() || null : null;
  const labels = Array.isArray(draft.labels) ? draft.labels : [];
  const name = names[0];
  const rule = { repository: `${site ?? ""}/${name ?? ""}`, assignee, labels };
  const alreadyAdded =
    !repository &&
    knownRepositories.some(
      (entry) =>
        entry.repository.toLowerCase() === rule.repository.toLowerCase(),
    );
  const blockedReason = !site
    ? "Enter a GitHub host, such as github.com."
    : signInRequired
      ? "Check sign-in for this GitHub host."
      : !name
        ? "Choose a repository to preview."
        : alreadyAdded
          ? "This repository is already on the list."
          : null;

  function update(key: string, value: string | string[]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setReview(null);
    setFailure("");
  }

  async function checkHost() {
    if (!site || checking) return;
    setChecking(true);
    setFailure("");
    try {
      setCheckedHost(await getGithubHostReadiness(site));
    } catch (reason) {
      setFailure(failureText(reason, "check GitHub sign-in"));
    } finally {
      setChecking(false);
    }
  }

  async function preview() {
    if (working || blockedReason) return;
    setWorking("preview");
    setFailure("");
    setReview(null);
    try {
      setReview(await previewGithubRepository(rule));
    } catch (reason) {
      setFailure(failureText(reason, "preview matches"));
    } finally {
      setWorking(null);
    }
  }

  async function save() {
    if (working || blockedReason || !review) return;
    setWorking("save");
    onSavingChange?.(true);
    setFailure("");
    try {
      await saveGithubRepository(rule);
      onSaved();
    } catch (reason) {
      setFailure(failureText(reason, "save the repository"));
    } finally {
      onSavingChange?.(false);
      setWorking(null);
    }
  }

  const fields = (
    <>
      {initialRepository && <p>{rule.repository}</p>}
      {!repository && !initialRepository && (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={hostId}>GitHub host</FieldLabel>
            <Input
              id={hostId}
              autoComplete="off"
              spellCheck={false}
              disabled={working !== null || checking}
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setCheckedHost(null);
                update("repositories", []);
              }}
            />
          </Field>
        </FieldGroup>
      )}
      {!repository &&
        site &&
        signInRequired &&
        (readiness ? (
          <SettingsList>
            <GithubSignInRow
              key={site}
              host={readiness}
              onChanged={(verified) => {
                if (verified) setCheckedHost(verified);
              }}
              onCheck={() => void checkHost()}
              cancelLabel="Cancel sign-in"
            />
          </SettingsList>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void checkHost()}
          >
            {checking ? "Checking sign-in…" : "Check sign-in"}
          </Button>
        ))}
      <SchemaForm
        key={repository ? undefined : site}
        fields={identity ? filterFields : addFields}
        draft={draft}
        errors={{}}
        disabled={working !== null || signInRequired}
        targetField="repositories"
        loadOptions={async (field, query) => {
          if (!site || signInRequired || (field === "labels" && !name))
            return [];
          const choices = await sourcesClient.options("github", field, query, {
            github_site: site,
            repositories: names,
            ...(repository?.project_login && {
              account: repository.project_login,
            }),
          });
          if (field !== "repositories") return choices;
          return choices.filter(
            ({ value }) =>
              !knownRepositories.some(
                ({ repository }) =>
                  repository.toLowerCase() === `${site}/${value.toLowerCase()}`,
              ),
          );
        }}
        onChange={update}
      />
      {review && (
        <SourcePreview
          preview={review}
          discoveryNote={undefined}
          refresh={() => void preview()}
          busy={working !== null}
        />
      )}
    </>
  );

  if (!repository)
    return (
      <DialogShell
        open
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
        title="Add a repository"
        primaryLabel={
          working === "preview"
            ? "Previewing…"
            : working === "save"
              ? "Saving…"
              : review
                ? "Add repository"
                : "Preview matches"
        }
        blockedReason={
          working
            ? working === "preview"
              ? "Checking for matching issues…"
              : "Saving the repository…"
            : blockedReason
        }
        onSubmit={() => void (review ? save() : preview())}
        busy={working !== null}
        error={failure}
        returnFocus={returnFocus}
      >
        {fields}
      </DialogShell>
    );

  return (
    <>
      {fields}
      {failure && (
        <Alert tone="error" size="compact">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={working !== null}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={working !== null || !!blockedReason}
          onClick={() => void (review ? save() : preview())}
        >
          {working === "preview"
            ? "Previewing…"
            : working === "save"
              ? "Saving…"
              : review
                ? "Save filters"
                : "Preview matches"}
        </Button>
      </div>
    </>
  );
}

/** Match Core's host syntax, including an explicit HTTPS port. */
function githubSite(input: string): string | null {
  const site = input.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[^:/?#@\s\\]+)(?::([0-9]+))?$/.exec(site);
  if (!match || (match[2] !== undefined && Number(match[2]) === 0)) return null;
  try {
    const url = new URL(`https://${site}`);
    if (
      !url.hostname.startsWith("[") &&
      !url.hostname
        .replace(/\.$/, "")
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    )
      return null;
    return url.host;
  } catch {
    return null;
  }
}
