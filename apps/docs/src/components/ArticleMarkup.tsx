import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { useRef, type HTMLAttributes } from "react";
import { CopyButton } from "./CopyButton";

export function ArticleCode({
  children,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  const pre = useRef<HTMLPreElement>(null);
  function read() {
    const code = pre.current!.cloneNode(true) as HTMLPreElement;
    for (const marker of code.querySelectorAll(".nd-copy-ignore"))
      marker.replaceWith("\n");
    return code.textContent ?? "";
  }
  return (
    <CodeBlock
      {...props}
      Actions={({ className, children: enabled }) => (
        <div className={className}>
          {enabled && <CopyButton action="code" read={read} />}
        </div>
      )}
    >
      <Pre ref={pre}>{children}</Pre>
    </CodeBlock>
  );
}

export function articleHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function Heading({
    id,
    className,
    children,
    ...props
  }: HTMLAttributes<HTMLHeadingElement>) {
    if (!id)
      return (
        <Tag {...props} className={className}>
          {children}
        </Tag>
      );
    function address() {
      const url = new URL(window.location.href);
      url.hash = id!;
      return url.href;
    }
    return (
      <Tag {...props} id={id} className={"doc-anchor " + (className ?? "")}>
        <a data-card="" href={"#" + id}>
          {children}
        </a>
        <CopyButton action="heading" read={address} />
      </Tag>
    );
  };
}
