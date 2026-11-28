import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import {
  cancelGithubSignIn,
  signInGithub,
  type GithubHost,
} from "@/lib/api/github";
import { failureText } from "@/lib/api/describe-failure";
import { writeClipboard } from "@/lib/clipboard";

export function GithubSignInRow({
  host,
  onChanged,
  onCheck,
  cancelLabel = "Cancel",
}: {
  host: GithubHost;
  onChanged: (host?: GithubHost) => void;
  onCheck: () => void;
  cancelLabel?: string;
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
    let verified: GithubHost | undefined;
    try {
      verified = await signInGithub(host.host, (code) => {
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
        onChanged(verified);
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
                  type="button"
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
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending.canceled}
            onClick={() => void cancel()}
          >
            {cancelLabel}
          </Button>
        ) : host.state === "not_signed_in" ? (
          <Button type="button" size="sm" onClick={() => void signIn()}>
            Sign in
          </Button>
        ) : host.state === "not_installed" ? (
          <Button
            type="button"
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
          <Button type="button" variant="outline" size="sm" onClick={onCheck}>
            Check again
          </Button>
        ) : undefined
      }
    />
  );
}
