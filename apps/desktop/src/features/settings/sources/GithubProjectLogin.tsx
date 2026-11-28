import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SettingsRow } from "@/features/settings/layout/SettingsList";
import {
  setGithubProjectLogin,
  type GithubProjectSite,
} from "@/lib/api/github";
import { failureText } from "@/lib/api/describe-failure";

export function GithubProjectLogin({
  site,
  onChanged,
}: {
  site: GithubProjectSite;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const inputId = useId();

  async function save(login: string | null) {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await setGithubProjectLogin(site.project.id, site.host, login);
      setEditing(false);
      toggle.current?.focus();
      onChanged();
    } catch (reason) {
      setFailure(failureText(reason, "save the Project login"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsRow
        title={`GitHub login for ${site.project.name}`}
        description={
          <>
            {site.host} · <span>{site.login ?? "Active GitHub CLI login"}</span>
          </>
        }
        trailing={
          <Button
            ref={toggle}
            type="button"
            size="sm"
            variant="outline"
            aria-label={`GitHub login for ${site.project.name}`}
            aria-expanded={editing}
            aria-controls={editing ? formId : undefined}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setDraft(site.login ?? "");
              setFailure("");
              setEditing(!editing);
            }}
          >
            {editing ? "Close" : "Change login"}
          </Button>
        }
      />
      {editing && (
        <form
          id={formId}
          className="space-y-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) void save(draft.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor={inputId}>GitHub CLI login</FieldLabel>
            <Input
              id={inputId}
              value={draft}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          {failure && (
            <Alert tone="error" size="compact">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            {site.login && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void save(null)}
              >
                Use active login
              </Button>
            )}
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              {busy ? "Saving…" : "Save Project login"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
