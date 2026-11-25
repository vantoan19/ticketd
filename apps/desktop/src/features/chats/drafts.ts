import type { ChatClient } from "@/features/chats/client";
import {
  ComposerAttachments,
  NO_ATTACHMENTS,
  type ChatAttachmentInput,
} from "@/features/chats/composer-attachments";
import type { Token } from "@/features/chats/composer-mentions";

type Action = "send" | "queue";
type Snapshot = {
  text: string;
  tokens: Token[];
  items: ReturnType<ComposerAttachments["snapshot"]>;
  saving: boolean;
  transfer: "pending" | "unconfirmed" | null;
  failedAction: Action | null;
  restored: boolean;
};
type QueuedDraft = {
  text: string;
  attachments: ChatAttachmentInput[];
};

/** One draft and its in-flight operations, independent of the mounted pane. */
export class ComposerDraft {
  private state: Snapshot;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | undefined;
  private staged:
    { payload: QueuedDraft; confirm: () => Promise<boolean> } | undefined;
  private attempt = { id: "", request: "" };
  prefilled: string | null = null;

  constructor(
    readonly attachments: ComposerAttachments,
    text = "",
    tokens: Token[] = [],
  ) {
    this.state = {
      text,
      tokens,
      items: attachments.snapshot(),
      saving: false,
      transfer: null,
      failedAction: null,
      restored: false,
    };
    if (attachments !== NO_ATTACHMENTS)
      attachments.subscribe(() =>
        this.update({ items: attachments.snapshot() }),
      );
  }

  snapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(changes: Partial<Snapshot>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }

  locked = () => this.state.saving || this.state.transfer !== null;

  setText(text: string, tokens: Token[]) {
    if (this.locked()) return false;
    this.update({
      text,
      tokens,
      restored: Boolean(text.trim()) && this.state.restored,
    });
    return true;
  }

  requestId(request: string) {
    if (request !== this.attempt.request)
      this.attempt = { id: crypto.randomUUID(), request };
    return this.attempt.id;
  }

  save(action: Action, send: () => Promise<void>) {
    if (this.locked()) return;
    this.update({ saving: true });
    this.saving = (async () => {
      try {
        await send();
        this.attempt = { id: "", request: "" };
        this.prefilled = null;
        this.state = {
          ...this.state,
          text: "",
          tokens: [],
          restored: false,
          failedAction: null,
        };
        if (this.state.items.length)
          this.attachments.remove(
            new Set(this.state.items.map((item) => item.id)),
          );
      } catch {
        this.update({ failedAction: action });
      } finally {
        this.update({ saving: false });
      }
    })();
  }

  append({ text, attachments }: QueuedDraft) {
    if (text) {
      const before = this.state.text;
      this.state = {
        ...this.state,
        text: before.trim() ? `${before}\n\n${text}` : text,
        restored: true,
      };
    }
    this.attachments.addCaptured(attachments);
  }

  async editQueued(
    read: () => Promise<QueuedDraft>,
    confirm: () => Promise<boolean>,
  ) {
    if (this.state.transfer) return;
    this.update({ transfer: "pending" });
    try {
      await this.saving;
      // Custody moves to this app-session draft before the host can delete
      // the saved copy. It is kept staged until the host confirms withdrawal.
      this.staged = { payload: await read(), confirm };
    } catch (reason) {
      this.update({ transfer: null });
      throw reason;
    }
    return this.confirmTransfer();
  }

  retryTransfer() {
    if (this.state.transfer === "unconfirmed") return this.confirmTransfer();
  }

  private async confirmTransfer() {
    if (!this.staged) return;
    const { payload, confirm } = this.staged;
    this.update({ transfer: "pending" });
    let withdrawn: boolean;
    try {
      withdrawn = await confirm();
    } catch {
      this.update({ transfer: "unconfirmed" });
      return;
    }
    this.staged = undefined;
    if (withdrawn) this.append(payload);
    this.update({ transfer: null });
    return withdrawn;
  }
}

const drafts = new WeakMap<ChatClient, Map<string, ComposerDraft>>();

export function draftOf(client: ChatClient, id: string): ComposerDraft {
  let chats = drafts.get(client);
  if (!chats) drafts.set(client, (chats = new Map()));
  let draft = chats.get(id);
  if (!draft) {
    draft = new ComposerDraft(
      new ComposerAttachments(client.captureAttachment),
    );
    chats.set(id, draft);
  }
  return draft;
}

/** Why a first message was carried into a Chat, shown once when it opens. */
export const arrivals = new Map<string, string>();
