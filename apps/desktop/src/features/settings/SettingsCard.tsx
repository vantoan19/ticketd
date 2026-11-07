import type { ReactNode } from "react";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import {
  settingsCardId,
  type SettingsCardKey,
} from "@/features/settings/settings-sections";

/** One titled card on the Settings page, reachable from the section list. */
export function SettingsCard({
  id,
  title,
  description,
  actions,
  children,
  footer,
}: {
  id: SettingsCardKey;
  title: string;
  /** A sentence at the top of the card body. */
  description?: ReactNode;
  /** Controls beside the title, such as Edit. */
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingId = `${settingsCardId(id)}-heading`;
  return (
    <Card asChild>
      <section
        id={settingsCardId(id)}
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <CardHeader>
          <h2 id={headingId}>{title}</h2>
          {actions}
        </CardHeader>
        <CardBody>
          {description && (
            <p className="settings-card-description">{description}</p>
          )}
          {children}
        </CardBody>
        {footer && <CardFooter>{footer}</CardFooter>}
      </section>
    </Card>
  );
}
