import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { workspaceClient } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/app-version";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

const DOCUMENTATION_URL = "https://github.com/vantoan19/ticketd#readme";
const ISSUES_URL = "https://github.com/vantoan19/ticketd/issues";

function AboutCard() {
  const [failure, setFailure] = useState("");
  const open = (url: string, what: string) => {
    setFailure("");
    workspaceClient
      .openLink(url)
      .catch((reason: unknown) =>
        setFailure(`Could not open ${what}: ${String(reason)}`),
      );
  };
  return (
    <SettingsCard id="about" title="About">
      <p className="settings-label">ticketd {APP_VERSION}</p>
      <p className="settings-hint">
        Your workspace stays on this computer. ticketd has no account and works
        offline.
      </p>
      <div className="settings-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => open(DOCUMENTATION_URL, "the documentation")}
        >
          <ExternalLink aria-hidden="true" />
          Documentation
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => open(ISSUES_URL, "the issue tracker")}
        >
          <ExternalLink aria-hidden="true" />
          Report an issue
        </Button>
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </SettingsCard>
  );
}

export function AboutPage() {
  return (
    <SettingsPage
      {...sectionMeta("about")}
      lede="What ticketd is, which version this is, and where to get help."
    >
      <AboutCard />
    </SettingsPage>
  );
}
