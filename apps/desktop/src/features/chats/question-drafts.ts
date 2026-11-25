import type { RequestAnswer } from "@/features/chats/client";

export type AnswerDraft = { text: string; pending: RequestAnswer | null };

/** Answers in the dock belong to the Chat and request, across pane mounts. */
export class QuestionDrafts {
  private drafts = new Map<string, AnswerDraft>();
  private listeners = new Set<() => void>();

  snapshot = (): ReadonlyMap<string, AnswerDraft> => this.drafts;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(id: string, draft: AnswerDraft | null) {
    this.drafts = new Map(this.drafts);
    if (draft) this.drafts.set(id, draft);
    else this.drafts.delete(id);
    for (const listener of this.listeners) listener();
  }

  setText(id: string, text: string) {
    if (!this.drafts.get(id)?.pending) {
      this.update(id, text ? { text, pending: null } : null);
    }
  }

  begin(id: string, answer: RequestAnswer) {
    const current = this.drafts.get(id);
    if (current?.pending) return false;
    this.update(id, { text: current?.text ?? "", pending: answer });
    return true;
  }

  settle(id: string, answer: RequestAnswer, completed: boolean) {
    const draft = this.drafts.get(id);
    if (draft?.pending !== answer) return;
    this.update(
      id,
      completed || !draft.text ? null : { text: draft.text, pending: null },
    );
  }

  close(id: string) {
    if (this.drafts.has(id)) this.update(id, null);
  }
}
