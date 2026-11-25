import type {
  ChatClient,
  HarnessOptions,
  LinkedRecord,
  QueueEditSave,
  QueueEditStatus,
} from "@/features/chats/client";
import type { Pick as HarnessPick } from "@/features/chats/harness-pick";
import { clearQuoteDrafts, type Quote } from "@/features/chats/quotes";
import type { FailureDescription } from "@/lib/api/describe-failure";
import {
  ComposerAttachments,
  NO_ATTACHMENTS,
  type ChatAttachmentInput,
} from "@/features/chats/composer-attachments";
import { linksOf, type Token } from "@/features/chats/composer-mentions";
import { QuestionDrafts } from "@/features/chats/question-drafts";

type Action = "send" | "queue";
export type SaveResult = void | "keep_draft";
type Snapshot = {
  text: string;
  tokens: Token[];
  items: ReturnType<ComposerAttachments["snapshot"]>;
  saving: boolean;
  transfer: "preparing" | "adopting" | "confirming" | "unconfirmed" | null;
  failedAction: Action | null;
  pendingCreate: PendingCreate | null;
  restored: boolean;
  queueEdits: string[];
};
export type PendingCreate = {
  request: Parameters<ChatClient["createChat"]>[0];
  links: LinkedRecord[];
  quotes: Quote[];
  options: HarnessOptions | undefined;
  pick: HarnessPick;
  submitted: Pick<Snapshot, "text" | "tokens" | "items">;
  failure: FailureDescription | null;
};

type QueuedDraft = {
  text: string;
  attachments: ChatAttachmentInput[];
};

type QueueSave = {
  key: string;
  edit: QueueEditSave;
  text: string;
  linkKey: string;
  attachmentIds: Set<number>;
  quotes: Quote[];
};

/** One draft and its in-flight operations, independent of the mounted pane. */
export class ComposerDraft {
  readonly questions = new QuestionDrafts();
  private state: Snapshot;
  private view: Snapshot;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | undefined;
  private current = true;
  private staged:
    | {
        queuedId: string;
        payload: QueuedDraft;
        cards: Snapshot["items"];
        confirm: () => Promise<boolean>;
      }
    | undefined;
  private attempt = { id: "", request: "" };
  private queueSaves = new Map<string, QueueSave>();
  private queueRemovals = new Set<string>();
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
      pendingCreate: null,
      restored: false,
      queueEdits: [],
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

  belongsToWorkspace = () => this.current;

  discard() {
    this.current = false;
  }

  locked = () =>
    !this.current || this.state.saving || this.state.transfer !== null;

  canPrefill() {
    const { text, items } = this.state;
    return (
      !this.locked() &&
      items.length === 0 &&
      (!text.trim() || text === this.prefilled)
    );
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

  setPendingCreate(pendingCreate: PendingCreate | null) {
    this.update({ pendingCreate });
  }

  repeatsRequest(request: string) {
    return request === this.attempt.request;
  }

  requestId(request: string) {
    if (request !== this.attempt.request)
      this.attempt = { id: crypto.randomUUID(), request };
    return this.attempt.id;
  }

  changedSince(submitted: Snapshot) {
    const current = this.state;
    return (
      current.text !== submitted.text ||
      current.tokens !== submitted.tokens ||
      current.items !== submitted.items ||
      current.queueEdits !== submitted.queueEdits
    );
  }

  save(action: Action, send: () => Promise<SaveResult>, keepDraft = false) {
    if (this.locked()) return;
    this.update({ saving: true });
    this.saving = (async () => {
      try {
        const result = await send();
        this.attempt = { id: "", request: "" };
        if (keepDraft || result === "keep_draft") {
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
          queueEdits: [],
        };
        this.removeAttachmentCards(this.state.items);
      } catch {
        this.update({ failedAction: action });
      } finally {
        this.update({ saving: false });
      }
    })();
  }

  settleCreateInput({ text, tokens, items }: PendingCreate["submitted"]) {
    this.clearAcceptedCaption(text.trim(), JSON.stringify(linksOf(tokens)));
    this.removeAttachmentCards(items);
  }

  private removeAttachmentCards(items: Snapshot["items"]) {
    if (items.length)
      this.attachments.remove(new Set(items.map((item) => item.id)));
  }

  /** A first message that could not be delivered joins its new Chat's draft. */
  async recover(payload: QueuedDraft) {
    await this.saving;
    if (this.current) this.append(payload);
  }

  private append({ text, attachments }: QueuedDraft) {
    this.state = { ...this.state, ...this.appendedText(text) };
    this.attachments.addCaptured(attachments);
  }

  private appendedText(text: string) {
    const before = this.state.text;
    return text
      ? {
          text: before.trim() ? `${before}\n\n${text}` : text,
          restored: true,
        }
      : {};
  }

  queueEditsToCheck() {
    return {
      saves: [...this.queueSaves.keys()],
      removals: [...this.queueRemovals],
    };
  }

  rememberQueueSave(
    edit: QueueEditSave,
    key: string,
    submitted: Snapshot,
    quotes: Quote[],
  ) {
    const { text, tokens, items } = submitted;
    this.queueSaves.set(edit.commandId, {
      key,
      edit,
      text: text.trim(),
      linkKey: JSON.stringify(linksOf(tokens)),
      attachmentIds: new Set(items.map((item) => item.id)),
      quotes,
    });
  }

  rememberQueueRemoval(queuedId: string) {
    if (this.state.queueEdits.includes(queuedId))
      this.queueRemovals.add(queuedId);
  }

  private clearAcceptedCaption(text: string, linkKey: string) {
    if (
      this.state.text.trim() === text &&
      JSON.stringify(linksOf(this.state.tokens)) === linkKey
    ) {
      this.prefilled = null;
      this.update({ text: "", tokens: [], restored: false });
    }
  }

  settleQueueEdits({ saved, removed }: QueueEditStatus, key?: string) {
    const consumed = new Set(removed);
    let sameDraft = false;
    const acknowledgedQuotes: Quote[] = [];
    for (const commandId of saved) {
      const pending = this.queueSaves.get(commandId);
      if (!pending) continue;
      sameDraft ||= pending.key === key;
      for (const id of pending.edit.messageIds) consumed.add(id);
      acknowledgedQuotes.push(...pending.quotes);
      // A changed draft keeps its new words and files, but has already sent
      // the unchanged text and the original attachment cards.
      this.clearAcceptedCaption(pending.text, pending.linkKey);
      if (pending.attachmentIds.size)
        this.attachments.remove(pending.attachmentIds);
    }
    if (consumed.size > 0) {
      for (const [commandId, { edit }] of this.queueSaves) {
        if (edit.messageIds.some((id) => consumed.has(id)))
          this.queueSaves.delete(commandId);
      }
      for (const id of consumed) this.queueRemovals.delete(id);
      this.update({
        queueEdits: this.state.queueEdits.filter((id) => !consumed.has(id)),
        ...(saved.length && { failedAction: null }),
      });
    }
    return { sameDraft, acknowledgedQuotes };
  }

  async editQueued(
    queuedId: string,
    read: () => Promise<QueuedDraft | undefined>,
    confirm: () => Promise<boolean>,
  ) {
    if (
      !this.current ||
      this.state.transfer ||
      this.state.queueEdits.includes(queuedId)
    )
      return;
    this.update({ transfer: "preparing" });
    try {
      await this.saving;
      if (!this.current) return;
      const payload = await read();
      if (!this.current) return;
      if (!payload) {
        this.update({ transfer: null });
        return;
      }
      this.staged = {
        queuedId,
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
    if (!this.current || !this.staged) return;
    const { queuedId, payload, confirm } = this.staged;
    this.update({ transfer: "confirming" });
    let held: boolean;
    try {
      held = await confirm();
    } catch {
      this.update({ transfer: "unconfirmed" });
      return;
    }
    if (!this.current) return;
    this.staged = undefined;
    if (held) {
      this.state = {
        ...this.state,
        queueEdits: [...this.state.queueEdits, queuedId],
      };
      this.append(payload);
    }
    this.update({ transfer: null });
    return held;
  }
}

const drafts = new WeakMap<ChatClient, Map<string, ComposerDraft>>();

export function discardChatDrafts(client: ChatClient) {
  for (const draft of drafts.get(client)?.values() ?? []) draft.discard();
  drafts.delete(client);
  arrivals.clear();
  clearQuoteDrafts();
}

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
