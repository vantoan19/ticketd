import type { ComponentProps } from "react";

/**
 * A link in Settings text that moves to another page or runs a small action.
 * It takes the size and line height of the text around it (12/16 in footers
 * and footnotes) and the link color; underline appears on hover.
 */
export function SettingsLink({
  className,
  type = "button",
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="settings-link"
      className={className ? `settings-link ${className}` : "settings-link"}
      {...props}
    />
  );
}
