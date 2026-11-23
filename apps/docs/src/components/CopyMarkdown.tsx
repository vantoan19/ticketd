import { useRef } from "react";
import { CopyButton } from "./CopyButton";

export function CopyMarkdown({ url }: { url: string }) {
  const article = useRef<string | null>(null);
  async function fetchArticle() {
    const response = await fetch(url);
    if (!response.ok) throw Error("The Markdown article could not be loaded");
    article.current = await response.text();
    return article.current;
  }
  return (
    <CopyButton
      action="article"
      read={() => article.current ?? fetchArticle()}
    />
  );
}
