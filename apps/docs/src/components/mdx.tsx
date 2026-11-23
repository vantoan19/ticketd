import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { ArticleCode, articleHeading } from "./ArticleMarkup";
import { links, siteUrl } from "../links";
import type { MDXComponents } from "mdx/types";

const headings = {
  h1: articleHeading("h1"),
  h2: articleHeading("h2"),
  h3: articleHeading("h3"),
  h4: articleHeading("h4"),
  h5: articleHeading("h5"),
  h6: articleHeading("h6"),
};

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...headings,
    pre: ArticleCode,
    a: (props: React.ComponentProps<"a">) => {
      const A = defaultMdxComponents.a!;
      const href = props.href?.startsWith("docs/adr/")
        ? links.repository + "/blob/main/" + props.href
        : props.href;
      if (href === "/llms.txt" || href === "/llms-full.txt")
        return <a {...props} href={siteUrl(href)} />;
      return <A {...props} href={href ?? "#"} />;
    },
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
