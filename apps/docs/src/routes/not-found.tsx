import { siteUrl } from "../links";

export function meta() {
  return [{ title: "Page not found · ticketd" }];
}
export default function NotFound() {
  return (
    <main id="main-content" className="site-width simple-page" tabIndex={-1}>
      <p className="kicker">404</p>
      <h1>Page not found.</h1>
      <a className="action-secondary" href={siteUrl("/docs")}>
        Back to the docs →
      </a>
    </main>
  );
}
