import type { ChatClient } from "@/features/chats/client";
import {
  ComposerAttachments,
  NO_ATTACHMENTS,
  type ChatAttachmentInput,
} from "@/features/chats/composer-attachments";
import type { Token } from "@/features/chats/composer-mentions";
import { QuestionDrafts } from "@/features/chats/question-drafts";

type Action = "send" | "queue";
type Snapshot = {
  text: string;
  tokens: Token[];
  items: ReturnType<ComposerAttachments["snapshot"]>;
  saving: boolean;
  transfer: "preparing" | "adopting" | "confirming" | "unconfirmed" | null;
  failedAction: Action | null;
  restored: boolean;
};
type QueuedDraft = {
  text: string;
  attachments: ChatAttachmentInput[];
};

/** One draft and its in-flight operations, independent of the mounted pane. */
export class ComposerDraft {
  readonly questions = new QuestionDrafts();
  private state: Snapshot;
  private view: Snapshot;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | undefined;
  private staged:
    | {
        payload: QueuedDraft;
        cards: Snapshot["items"];
        confirm: () => Promise<boolean>;
      }
    | undefined;
  private attempt = { id: "", request: "" };
  private prefilled: string | null = null;

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
    this.view = this.state;
    if (attachments !== NO_ATTACHMENTS)
      attachments.subscribe(() =>
        this.update({ items: attachments.snapshot() }),
      );
  }

  snapshot = () => this.view;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(changes: Partial<Snapshot>) {
    this.state = { ...this.state, ...changes };
    const staged = this.staged;
    this.view = staged
      ? {
          ...this.state,
          ...this.appendedText(staged.payload.text),
          items: [...this.state.items, ...staged.cards],
        }
      : this.state;
    for (const listener of this.listeners) listener();
  }

  locked = () => this.state.saving || this.state.transfer !== null;

  canPrefill() {
    const { text } = this.state;
    return !this.locked() && (!text.trim() || text === this.prefilled);
  }

  setText(text: string, tokens: Token[], prefilled = false) {
    if (this.locked()) return false;
    if (prefilled) this.prefilled = text;
    else if (text !== this.prefilled) this.prefilled = null;
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

  save(action: Action, send: () => Promise<void>, keepDraft = false) {
    if (this.locked()) return;
    this.update({ saving: true });
    this.saving = (async () => {
      try {
        await send();
        this.attempt = { id: "", request: "" };
        if (keepDraft) {
          this.update({ failedAction: null });
          return;
        }
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

  /** A first message that could not be delivered joins its new Chat's draft. */
  async recover(payload: QueuedDraft) {
    await this.saving;
    this.append(payload);
  }

  private append({ text, attachments }: QueuedDraft) {
    this.state = { ...this.state, ...this.appendedText(text) };
    this.attachments.addCaptured(attachments);
  }

  private appendedText(text: string) {
    const before = this.state.text;
    return text
      ? { text: before.trim() ? `${before}\n\n${text}` : text, restored: true }
      : {};
  }

  async editQueued(
    read: () => Promise<QueuedDraft>,
    confirm: () => Promise<boolean>,
  ) {
    if (this.state.transfer) return;
    this.update({ transfer: "preparing" });
    try {
      await this.saving;
      const payload = await read();
      this.staged = {
        payload,
        confirm,
        // Captured preview IDs are disjoint from ordinary draft attachments.
        cards: payload.attachments.map((content, index) => ({
          id: -index - 1,
          name: content.name,
          state: "ready",
          content,
        })),
      };
      this.update({ transfer: "adopting" });
    } catch (reason) {
      this.update({ transfer: null });
      throw reason;
    }
  }

  /** Called only after a mounted composer displays the complete locked draft. */
  adoptTransfer() {
    if (this.state.transfer === "adopting") return this.confirmTransfer();
  }

  retryTransfer() {
    if (this.state.transfer === "unconfirmed") return this.confirmTransfer();
  }

  private async confirmTransfer() {
    if (!this.staged) return;
    const { payload, confirm } = this.staged;
    this.update({ transfer: "confirming" });
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
