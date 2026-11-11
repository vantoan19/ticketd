import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Link } from "react-router";
import { baseOptions } from "@/lib/layout.shared";

export function meta() {
  return [{ title: "Not found · ticketd" }];
}

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <p className="mb-3 font-mono text-xs tracking-widest text-fd-muted-foreground">
          404 · NOT ON THE SHEET
        </p>
        <h1 className="mb-2 text-2xl font-medium tracking-tight">
          This page could not be found.
        </h1>
        <p className="mb-6 text-fd-muted-foreground">
          The link may be old, or the page may have moved.
        </p>
        <Link
          className="border border-fd-foreground bg-fd-foreground px-4 py-2.5 text-sm font-medium text-fd-background"
          to="/docs"
        >
          Back to the docs
        </Link>
      </div>
    </HomeLayout>
  );
}
