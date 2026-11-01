import { Fragment } from "react";

/**
 * A command that wraps only between its arguments, never inside one such as
 * `--relationships`, so a wrapped command still reads as it is typed.
 */
export function CommandText({ command }: { command: string }) {
  return command.split(" ").map((part, index) => (
    <Fragment key={index}>
      {index > 0 && " "}
      <span className="command-part">{part}</span>
    </Fragment>
  ));
}
