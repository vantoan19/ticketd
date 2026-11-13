import { useEffect, useRef, type ReactNode } from "react";
import { Bot, ChevronDown, Folder, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  HARNESS_NAMES,
  type AutomationAgent,
} from "@/features/automations/client";
import { agentReach, folderName } from "@/features/automations/automation-text";
import { useChatClient } from "@/features/chats/client";

/**
 * The panel beside the canvas that sets up the selected card. It takes focus
 * when it opens, and Esc closes it; the editor returns focus to the card.
 */
export function StepPanel({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  return (
    <aside
      ref={panel}
      className="flow-panel"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="flow-panel-head">
        <h3>
          {icon}
          {title}
        </h3>
        <IconButton label="Close panel" onClick={onClose}>
          <X aria-hidden />
        </IconButton>
      </div>
      {children}
    </aside>
  );
}

export function RunAgentFields({
  agentId,
  folder,
  agents,
  onChange,
  onNewAgent,
  onEditAgent,
  onFail,
}: {
  agentId: string | null;
  folder: string | null;
  agents: AutomationAgent[];
  onChange: (patch: { agent_id?: string; execution_folder?: string }) => void;
  onNewAgent: () => void;
  onEditAgent: (id: string) => void;
  onFail: (reason: unknown) => void;
}) {
  const chat = useChatClient();
  const agent = agents.find((item) => item.id === agentId);
  const agentName = agent ? agent.name.trim() || "New agent" : null;
  return (
    <>
      <div className="flow-panel-section">
        <span aria-hidden="true">Agent</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-start"
              aria-label={agentName ? `Agent: ${agentName}` : "Agent"}
            >
              <Bot aria-hidden />
              <span className="flow-pick-text">
                {agentName ?? "Choose an agent"}
              </span>
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-70"
            aria-label="Agent"
          >
            {agents.map((item) => (
              <DropdownMenuItem
                key={item.id}
                className="items-start whitespace-normal"
                onSelect={() => onChange({ agent_id: item.id })}
              >
                <span className="flow-menu-item-text">
                  {item.name.trim() || "New agent"}
                  <small>{HARNESS_NAMES[item.harness]}</small>
                </span>
              </DropdownMenuItem>
            ))}
            {agents.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={onNewAgent}>
              New agent…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {agent && (
          <p className="flow-panel-note">
            {agentReach(agent)}{" "}
            <button
              type="button"
              className="settings-link"
              onClick={() => onEditAgent(agent.id)}
            >
              Edit agent
            </button>
          </p>
        )}
      </div>
      <div className="flow-panel-section">
        <span aria-hidden="true">Folder</span>
        <Button
          variant="outline"
          className="w-full justify-start"
          aria-label={folder ? `Folder: ${folder}` : "Folder"}
          onClick={() =>
            void chat
              .pickFolder()
              .then(
                (path) => path && onChange({ execution_folder: path }),
                onFail,
              )
          }
        >
          <Folder aria-hidden />
          <span className="flow-pick-text">
            {folder ? folderName(folder) : "Choose a folder…"}
          </span>
        </Button>
        <p className="flow-panel-note">
          {folder ? <code>{folder}</code> : "The agent works in this folder."}
        </p>
      </div>
    </>
  );
}
