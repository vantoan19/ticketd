import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { workspaceClient } from "@/lib/api/workspace";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Badge } from "@/components/ui/badge";
import { APP_VERSION } from "@/lib/app-version";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import { AboutUpdates } from "@/features/settings/pages/AboutUpdates";
import { SupportCards } from "@/features/settings/pages/SupportCards";
import { openBugReport } from "@/lib/issue-url";
import { REPOSITORY_URL } from "@/lib/support-links";
import "@/features/settings/pages/about-page.css";

const REPOSITORY = REPOSITORY_URL;
const DOCUMENTATION_URL = `${REPOSITORY}#readme`;
const BUG_FORM_URL = `${REPOSITORY}/issues/new?template=bug_report.yml`;
const PRIVACY_URL = `${REPOSITORY}/blob/main/PRIVACY.md`;
const NOTICES_URL = `${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md`;

function LinkText({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <span className="about-link-text">
      <span className="about-link-title">{title}</span>
      <span className="about-link-description">{description}</span>
    </span>
  );
}

/** A link row that opens a web page through the app, never in this window. */
function ExternalRow({
  title,
  description,
  url,
  open = () => workspaceClient.openLink(url),
  what,
  onFailure,
}: {
  title: string;
  description: string;
  /** Where the row points; `open` can fill details in first. */
  url: string;
  open?: () => Promise<void>;
  /** For the failure sentence: "the documentation". */
  what: string;
  onFailure: (failure: FailureDescription | null) => void;
}) {
  return (
    <a
      className="about-link-row"
      href={url}
      onClick={(event) => {
        event.preventDefault();
        onFailure(null);
        open().catch((reason: unknown) =>
          onFailure(describeFailure(reason, `open ${what}`)),
        );
      }}
    >
      <LinkText title={title} description={description} />
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

/** A link that would not open, shown under the list that holds it. */
function Failure({
  failure,
}: {
  failure: FailureDescription | null;
}): ReactNode {
  return failure ? (
    <FailureAlert size="compact" failure={failure} className="mt-3" />
  ) : null;
}

export function AboutPage() {
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  return (
    <SettingsPage
      {...sectionMeta("about")}
      title="ticketd"
      wordmark
      lede={
        <>
          <span className="font-mono">{`Version ${APP_VERSION}`}</span>
          <Badge>Desktop app and command line</Badge>
        </>
      }
      ledeNote="No account · Works offline · No analytics"
    >
      <AboutUpdates />

      <SettingsSection title="Help">
        <SettingsList>
          <ExternalRow
            title="Documentation"
            description="Guides for the desktop app and the command line."
            url={DOCUMENTATION_URL}
            what="the documentation"
            onFailure={setFailure}
          />
          <ExternalRow
            title="Report an issue"
            description="Opens GitHub’s bug form with your version filled in."
            url={BUG_FORM_URL}
            open={openBugReport}
            what="the bug form"
            onFailure={setFailure}
          />
          <ExternalRow
            title="Privacy"
            description="What stays on this computer, and what each integration sends."
            url={PRIVACY_URL}
            what="the privacy notice"
            onFailure={setFailure}
          />
          <ExternalRow
            title="Third-party notices"
            description="Licenses for the libraries and fonts ticketd ships with."
            url={NOTICES_URL}
            what="the third-party notices"
            onFailure={setFailure}
          />
        </SettingsList>
        <Failure failure={failure} />
      </SettingsSection>

      <SupportCards />
    </SettingsPage>
  );
}
