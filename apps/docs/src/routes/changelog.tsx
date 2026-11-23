import { useLoaderData } from "react-router";
import { ArrowUpRight } from "lucide-react";
import sprite from "virtual:ticketd-art";
import { getReleases } from "../lib/releases.server";
import { links } from "../links";
import "./distribution.css";

export const meta = () => [
  { title: "Changelog · ticketd" },
  {
    name: "description",
    content: "Published ticketd releases, release notes and downloads.",
  },
];
export async function loader() {
  return getReleases();
}
const date = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
export default function Changelog() {
  const { releases, status } = useLoaderData<typeof loader>();
  return (
    <main
      className="distribution site-width changes"
      id="main-content"
      tabIndex={-1}
    >
      <div className="distribution-lead">
        <div>
          <h1 className="page-heading">Changelog.</h1>
          <p>
            What ships in ticketd, from the project’s published GitHub Releases.
          </p>
          <a className="text-link" href={links.releases}>
            GitHub Releases <ArrowUpRight size={15} />
          </a>
        </div>
        <svg
          viewBox="-107 -64 272 219"
          role="img"
          aria-label="The release ledger on its writing platform."
        >
          <use href={sprite + "#ledger-model"} />
        </svg>
      </div>
      <section className="release-list" aria-label="Published releases">
        {releases.length ? (
          releases.map((release) => (
            <article key={release.url} className="published-release">
              <time dateTime={release.date}>
                {date.format(new Date(release.date))}
              </time>
              <div>
                <h2>
                  <a href={release.url}>{release.name}</a>
                </h2>
                {release.preview && (
                  <p className="release-kind">Published preview</p>
                )}
                {release.notes && (
                  <div
                    className="release-notes"
                    dangerouslySetInnerHTML={{ __html: release.notes }}
                  />
                )}
                <a className="text-link" href={release.url}>
                  View release on GitHub ↗
                </a>
              </div>
            </article>
          ))
        ) : (
          <article>
            <span className="release-indicator" aria-hidden="true" />
            <div>
              <h2>
                {status === "published"
                  ? "No public releases yet."
                  : "Release notes are unavailable."}
              </h2>
              <p>
                {status === "published"
                  ? "You can build the desktop app and CLI from the source repository."
                  : "GitHub’s release list could not be reached when this page was built. The project’s releases page has the latest information."}
              </p>
              <a
                className="text-link"
                href={
                  status === "published" ? links.repository : links.releases
                }
              >
                {status === "published"
                  ? "Get it on GitHub"
                  : "Open GitHub Releases"}{" "}
                <ArrowUpRight size={15} />
              </a>
            </div>
          </article>
        )}
      </section>
    </main>
  );
}
