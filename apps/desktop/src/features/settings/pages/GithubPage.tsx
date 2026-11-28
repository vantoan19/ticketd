import { useEffect, useRef, useState, type ComponentProps } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, CircleDot, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status-label";
import { SettingsDrillIn } from "@/features/settings/layout/SettingsDrillIn";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { GithubRepositories } from "@/features/settings/sources/GithubRepositories";
import { GithubMark } from "@/features/settings/sources/GithubMark";
import {
  cancelGithubSignIn,
  signInGithub,
  type GithubHost,
  type GithubIntegration,
} from "@/lib/api/github";
import { failureText } from "@/lib/api/describe-failure";
import { writeClipboard } from "@/lib/clipboard";

export function GithubPage({
  integration,
  onBack,
  onChanged,
  projectSetup,
}: {
  integration: GithubIntegration | null;
  onBack: () => void;
  onChanged: () => void;
  projectSetup?: ComponentProps<typeof GithubRepositories>["projectSetup"];
}) {
  return (
    <SettingsDrillIn
      parent="ticket-sources"
      label="GitHub"
      lede="Your GitHub issues arrive as tickets. Edit them in GitHub."
      icon={CircleDot}
      iconContent={<GithubMark />}
      onBack={onBack}
    >
      <section className="settings-section" aria-label="GitHub sign-in">
        <SettingsList>
          {integration ? (
            integration.hosts.map((host) => (
              <GithubSignInRow
                key={host.host}
                host={host}
                onChanged={onChanged}
              />
            ))
          ) : (
            <SettingsRow
              leading={
                <SettingsRowTile>
                  <UserRound />
                </SettingsRowTile>
              }
              title={<StatusLabel tone="attention">Unavailable</StatusLabel>}
              trailing={
                <Button variant="outline" size="sm" onClick={onChanged}>
                  Check again
                </Button>
              }
            />
          )}
        </SettingsList>
      </section>
      {integration && (
        <GithubRepositories
          integration={integration}
          onChanged={onChanged}
          {...(projectSetup && { projectSetup })}
        />
      )}
    </SettingsDrillIn>
  );
}

function GithubSignInRow({
  host,
  onChanged,
}: {
  host: GithubHost;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<{
    code: string;
    canceled: boolean;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const run = useRef<{ canceled: boolean } | null>(null);
  useEffect(
    () => () => {
      if (!run.current) return;
      run.current.canceled = true;
      run.current = null;
      void cancelGithubSignIn(host.host).catch(() => {});
    },
    [host.host],
  );

  async function signIn() {
    if (run.current) return;
    const operation = { canceled: false };
    run.current = operation;
    setPending({ code: "", canceled: false });
    setMessage("");
    setCopyFeedback("");
    try {
      await signInGithub(host.host, (code) => {
        if (run.current === operation && !operation.canceled)
          setPending({ code, canceled: false });
      });
    } catch (reason) {
      if (run.current === operation && !operation.canceled)
        setMessage(failureText(reason, "sign in to GitHub"));
    } finally {
      if (run.current === operation) {
        run.current = null;
        setPending(null);
        onChanged();
      }
    }
  }

  async function cancel() {
    const operation = run.current;
    if (!operation) return;
    operation.canceled = true;
    setPending({ code: "", canceled: true });
    try {
      await cancelGithubSignIn(host.host);
    } catch (reason) {
      if (run.current === operation) {
        operation.canceled = false;
        setMessage(failureText(reason, "cancel GitHub sign-in"));
        setPending(pending);
      }
    }
  }

  const connected = host.state === "connected";
  const label = {
    connected: `Signed in as ${host.login ?? host.host}`,
    not_installed: "Not installed",
    not_signed_in: "Not signed in",
    unavailable: "Unavailable",
  }[host.state];
  return (
    <SettingsRow
      leading={
        <SettingsRowTile>
          <UserRound />
        </SettingsRowTile>
      }
      title={
        pending ? (
          <span role="status">
            {pending.canceled ? "Canceling…" : "Signing in…"}
          </span>
        ) : (
          <StatusLabel tone={connected ? "positive" : "attention"}>
            {label}
          </StatusLabel>
        )
      }
      description={
        <>
          {pending ? (
            pending.code ? (
              <span role="status">
                Enter <code className="font-mono">{pending.code}</code> in your
                browser.{" "}
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => {
                    void writeClipboard(pending.code).then((error) =>
                      setCopyFeedback(
                        error
                          ? `Could not copy the code because ${error}.`
                          : "Code copied.",
                      ),
                    );
                  }}
                >
                  Copy code
                </Button>
                {copyFeedback && <span> {copyFeedback}</span>}
              </span>
            ) : (
              "Waiting for GitHub to open in your browser."
            )
          ) : connected ? (
            `Your gh login for ${host.host}. ticketd never stores a GitHub token.`
          ) : (
            (host.message ?? `GitHub CLI sign-in for ${host.host}.`)
          )}
          {message && <div role="status">{message}</div>}
        </>
      }
      trailing={
        pending ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending.canceled}
            onClick={() => void cancel()}
          >
            Cancel
          </Button>
        ) : host.state === "not_signed_in" ? (
          <Button size="sm" onClick={() => void signIn()}>
            Sign in
          </Button>
        ) : host.state === "not_installed" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void openUrl("https://cli.github.com/").catch((reason: unknown) =>
                setMessage(failureText(reason, "open the GitHub CLI website")),
              );
            }}
          >
            Get gh <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : host.state === "unavailable" ? (
          <Button variant="outline" size="sm" onClick={onChanged}>
            Check again
          </Button>
        ) : undefined
      }
    />
  );
}
