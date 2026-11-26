import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  ExternalLink,
  HardDrive,
  UserRoundX,
  WifiOff,
} from "lucide-react";
import { workspaceClient } from "@/lib/api/workspace";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Badge } from "@/components/ui/badge";
import { APP_VERSION } from "@/lib/app-version";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import { AboutUpdates } from "@/features/settings/pages/AboutUpdates";
import { SupportCards } from "@/features/settings/pages/SupportCards";
import { REPOSITORY_URL } from "@/lib/support-links";
import "@/features/settings/pages/about-page.css";

const REPOSITORY = REPOSITORY_URL;
const DOCUMENTATION_URL = `${REPOSITORY}#readme`;
const ISSUES_URL = `${REPOSITORY}/issues`;
const PRIVACY_URL = `${REPOSITORY}/blob/main/PRIVACY.md`;
const NOTICES_URL = `${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md`;

const PROMISES = [
  {
    icon: UserRoundX,
    title: "No account",
    description: "ticketd has no account to sign up for.",
  },
  {
    icon: WifiOff,
    title: "Works offline",
    description: "Everything you do runs on this computer.",
  },
  {
    icon: HardDrive,
    title: "Stays on this computer",
    description:
      "No analytics or crash uploads. Only update checks and the integrations you turn on, such as Google Drive or a ticket source, go online.",
  },
];

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
  what,
  onFailure,
}: {
  title: string;
  description: string;
  url: string;
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
        workspaceClient
          .openLink(url)
          .catch((reason: unknown) =>
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

type ListFailure = { list: "help" | "privacy"; failure: FailureDescription };

export function AboutPage() {
  const { openPage } = useSettingsState();
  const [failure, setFailure] = useState<ListFailure | null>(null);
  const report =
    (list: ListFailure["list"]) => (next: FailureDescription | null) =>
      setFailure(next && { list, failure: next });
  return (
    <SettingsPage
      {...sectionMeta("about")}
      title="ticketd"
      wordmark
      lede={
        <>
          <span className="font-mono">Version {APP_VERSION}</span>
          <Badge>Desktop app and command line</Badge>
        </>
      }
    >
      <section className="settings-section">
        <ul className="about-promises" aria-label="How ticketd works">
          {PROMISES.map(({ icon: Icon, title, description }) => (
            <li key={title} className="about-promise">
              <Icon size={20} aria-hidden="true" />
              <span className="about-link-title">{title}</span>
              <span className="about-link-description">{description}</span>
            </li>
          ))}
        </ul>
      </section>

      <AboutUpdates />

      <SettingsSection title="Help">
        <SettingsList>
          <ExternalRow
            title="Documentation"
            description="Guides for the desktop app and the command line."
            url={DOCUMENTATION_URL}
            what="the documentation"
            onFailure={report("help")}
          />
          <ExternalRow
            title="Report an issue"
            description="Opens the issue tracker in your browser. Include the version above."
            url={ISSUES_URL}
            what="the issue tracker"
            onFailure={report("help")}
          />
          <button
            type="button"
            className="about-link-row"
            onClick={() => openPage("keyboard-shortcuts")}
          >
            <LinkText
              title="Keyboard shortcuts"
              description="Keys that work across ticketd."
            />
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </SettingsList>
        <Failure failure={failure?.list === "help" ? failure.failure : null} />
      </SettingsSection>

      <SettingsSection title="Privacy and notices">
        <SettingsList>
          <ExternalRow
            title="Privacy"
            description="What stays on this computer, and what each integration sends."
            url={PRIVACY_URL}
            what="the privacy notice"
            onFailure={report("privacy")}
          />
          <ExternalRow
            title="Third-party notices"
            description="Licenses for the libraries and fonts ticketd ships with."
            url={NOTICES_URL}
            what="the third-party notices"
            onFailure={report("privacy")}
          />
        </SettingsList>
        <Failure
          failure={failure?.list === "privacy" ? failure.failure : null}
        />
      </SettingsSection>

      <SupportCards />
    </SettingsPage>
  );
}
