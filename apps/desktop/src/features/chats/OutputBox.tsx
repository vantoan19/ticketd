import { useLayoutEffect, useRef } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useCopy } from "@/components/ui/use-copy";
import { plainOutput } from "@/features/chats/model";

/**
 * A command's detail: `$ command`, its output and Copy, in one box at most 12 lines
 * tall that scrolls inside. It mounts when its row opens, at the output's last line,
 * where a command says how it went. The `$` is neither selected nor copied.
 */
export function OutputBox({
  id,
  command,
  output,
}: {
  id: string;
  command: string;
  output?: string | null | undefined;
}) {
  const view = useRef<HTMLDivElement>(null);
  const text = output ? plainOutput(output) : "";
  const { copied, error, copy } = useCopy();
  useLayoutEffect(() => {
    const box = view.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, []);
  return (
    <div className="chat-output" id={id}>
      <div
        ref={view}
        className="chat-output-view"
        role="region"
        aria-label={`Output of ${command.split("\n")[0] ?? command}`}
        tabIndex={0}
      >
        <pre>
          <span aria-hidden="true" className="chat-output-prompt">
            {"$ "}
          </span>
          {command}
          {text ? `\n\n${text}` : ""}
        </pre>
      </div>
      <span className="chat-output-copy">
        <IconButton
          label="Copy output"
          onClick={() =>
            void copy("Output", text ? `${command}\n\n${text}` : command)
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
      </span>
      {error && (
        <span className="sr-only" role="status">
          {error}
        </span>
      )}
    </div>
  );
}
