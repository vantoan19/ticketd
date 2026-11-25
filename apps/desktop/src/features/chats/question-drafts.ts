import type { RequestAnswer } from "@/features/chats/client";
import type { Token } from "@/features/chats/composer-mentions";

export type AnswerDraft = {
  text: string;
  pending: RequestAnswer | null;
  inComposer?: boolean;
  tokens?: Token[];
};

/** Answer drafts belong to the request across pane mounts and input locations. */
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

  setText(
    id: string,
    text: string,
    source: Pick<AnswerDraft, "tokens" | "inComposer"> = {},
  ) {
    if (this.drafts.get(id)?.pending) return false;
    this.update(id, text ? { ...source, text, pending: null } : null);
    return true;
  }

  begin(id: string, answer: RequestAnswer, inComposer = false) {
    const current = this.drafts.get(id);
    if (current?.pending) return false;
    this.update(id, {
      ...current,
      text: current?.text ?? "",
      pending: answer,
      inComposer,
    });
    return true;
  }

  settle(id: string, answer: RequestAnswer, completed: boolean) {
    const draft = this.drafts.get(id);
    if (draft?.pending !== answer) return;
    this.update(
      id,
      completed || !draft.text ? null : { ...draft, pending: null },
    );
  }

  close(id: string) {
    if (this.drafts.has(id)) this.update(id, null);
  }
}
