import { useState } from "react";
import { CircleCheck, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { usePreferences } from "@/lib/preferences";
import { BUY_ME_A_COFFEE_URL, REPOSITORY_URL } from "@/lib/support-links";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SetupChecklist } from "@/features/setup/SetupChecklist";
import "@/features/settings/pages/setup-page.css";

/** The one quiet line of the finished checklist: plain links that open the browser. */
function SupportLine() {
  const coffee = BUY_ME_A_COFFEE_URL;
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const open = (url: string, what: string) => {
    setFailure(null);
    workspaceClient
      .openLink(url)
      .catch((reason: unknown) =>
        setFailure(describeFailure(reason, `open ${what}`)),
      );
  };
  return (
    <>
      <p className="setup-support">
        {"ticketd is free and open source. If it helps you, "}
        <a
          className="settings-link"
          href={REPOSITORY_URL}
          onClick={(event) => {
            event.preventDefault();
            open(REPOSITORY_URL, "GitHub");
          }}
        >
          Star on GitHub
        </a>
        {coffee && (
          <>
            {" or "}
            <a
              className="settings-link"
              href={coffee}
              onClick={(event) => {
                event.preventDefault();
                open(coffee, "Buy me a coffee");
              }}
            >
              Buy me a coffee
            </a>
          </>
        )}
        .
      </p>
      {failure && (
        <FailureAlert size="compact" failure={failure} className="mt-3" />
      )}
    </>
  );
}

/**
 * Set up ticketd: five steps that tick themselves from this computer. Hidden
 * or finished, the sidebar row goes; Search still finds this page.
 */
export function SetupPage() {
  const { setup, hideSetup } = useSettingsState();
  const { setupHidden, setupFinished } = usePreferences();
  const statusLine = useStatusLine();
  const finished = setup?.complete ?? false;
  const hide = () => {
    hideSetup?.();
    statusLine.show({
      message: "Checklist hidden. Search “set up” to find it again.",
      icon: <CircleCheck />,
    });
  };
  return (
    <SettingsPage
      {...sectionMeta("setup")}
      endSlot={
        !finished && !setupHidden && !setupFinished ? (
          <Button type="button" variant="ghost" size="sm" onClick={hide}>
            <EyeOff aria-hidden="true" />
            Hide checklist
          </Button>
        ) : undefined
      }
    >
      <section className="settings-section">
        <SetupChecklist />
        {finished && <SupportLine />}
      </section>
    </SettingsPage>
  );
}
