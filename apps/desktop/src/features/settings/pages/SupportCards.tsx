import { useState } from "react";
import { Coffee, ExternalLink, Star } from "lucide-react";
import { workspaceClient } from "@/lib/api/workspace";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { IconTile } from "@/components/ui/icon-tile";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { BUY_ME_A_COFFEE_URL, REPOSITORY_URL } from "@/lib/support-links";
import "@/features/settings/pages/support-cards.css";

/**
 * Two plain ways to help ticketd, each opening the browser. Nothing is
 * tracked, and nothing nags. The Buy me a coffee card shows only once the
 * maintainer's page is known.
 */
export function SupportCards({
  coffeeUrl = BUY_ME_A_COFFEE_URL,
}: {
  coffeeUrl?: string | null;
}) {
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
    <SettingsSection title="Support ticketd">
      <div className="support-cards">
        <div className="settings-list support-card" data-kind="star">
          <IconTile>
            <Star size={24} />
          </IconTile>
          <div className="support-card-body">
            <p>Helps other people find ticketd.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => open(REPOSITORY_URL, "the repository")}
            >
              Star on GitHub
              <ExternalLink aria-hidden="true" />
            </Button>
          </div>
        </div>
        {coffeeUrl ? (
          <div className="settings-list support-card" data-kind="coffee">
            <IconTile>
              <Coffee size={24} />
            </IconTile>
            <div className="support-card-body">
              <p>Helps one maintainer keep ticketd going.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => open(coffeeUrl, "the Buy me a coffee page")}
              >
                Buy me a coffee
                <ExternalLink aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {failure ? (
        <FailureAlert size="compact" failure={failure} className="mt-3" />
      ) : null}
    </SettingsSection>
  );
}
