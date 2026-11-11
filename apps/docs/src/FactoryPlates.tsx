import type { CSSProperties } from "react";
import plates from "./FactoryPlates.markup.json";
import { contextKeys, contextRecords, type ContextKey } from "./factoryRecords";

const sourceLabels: Record<ContextKey, string> = {
  spec: "SPEC",
  notes: "NOTES",
  update: "UPDATE",
  evidence: "PR #87",
};

// Static geometry is generated from the original drawing primitives. Keep live
// text and relationships in React, outside that markup.
function Ink({ part }: { part: string }) {
  return <g aria-hidden="true" dangerouslySetInnerHTML={{ __html: part }} />;
}

const drawerPositions: Record<ContextKey, [number, number]> = {
  spec: [86, 150],
  notes: [183, 204],
  update: [280, 204],
  evidence: [280, 258],
};

export function ContextArchive({
  selected,
  packed,
  packRun,
}: {
  selected: ContextKey;
  packed: readonly ContextKey[];
  packRun: number;
}) {
  const shared = contextRecords[selected].tickets.length === 2;
  const packetSource =
    packRun > 0 && !packed.includes(selected)
      ? (packed[0] ?? selected)
      : selected;
  return (
    <figure
      className="fp-figure fp-archive"
      data-prepared={packRun > 0}
      data-run={packRun ? (packRun % 2 ? "a" : "b") : undefined}
    >
      <div className="fp-scroll">
        <svg
          className="x-art fp-scene"
          viewBox="0 20 1200 388"
          aria-hidden="true"
          style={
            {
              "--needle": `${-120 + packed.length * 60}deg`,
              "--source-angle": `${-110 + contextKeys.indexOf(selected) * 75}deg`,
            } as CSSProperties
          }
        >
          <g className="fp-archive-body">
            <Ink part={plates.archive.body} />
          </g>
          {contextKeys.map((key) => (
            <g
              key={key}
              transform={`translate(${drawerPositions[key].join(" ")})`}
            >
              <g className="fp-drawer" data-selected={selected === key}>
                <g className="fp-drawer-slide" aria-hidden="true">
                  <Ink
                    part={
                      selected === key
                        ? plates.archive.drawerOpen
                        : plates.archive.drawerClosed
                    }
                  />
                  <text
                    x="45.5"
                    y="17.5"
                    fontSize="8"
                    textAnchor="middle"
                    className="fp-drawer-text"
                  >
                    {sourceLabels[key]}
                  </text>
                </g>
              </g>
            </g>
          ))}
          <g aria-hidden="true">
            <text
              x="510"
              y="154"
              fontSize="10"
              textAnchor="middle"
              className="x-tp"
            >
              {sourceLabels[selected]}
            </text>
            <text x="472" y="313" fontSize="13" className="x-ta">
              0{shared ? 2 : 1}
            </text>
            <g key={selected} className="fp-source-trace">
              <path
                className="x-sa fp-flow-path"
                d="M568 191H603Q614 191 614 180V135Q614 124 626 124H871Q883 124 883 136V210"
              />
              {shared && (
                <path
                  className="x-sa fp-flow-path"
                  d="M883 124H1043Q1055 124 1055 136V210"
                />
              )}
            </g>
            <rect className="x-p x-i" x="565" y="188" width="6" height="6" />
            <text
              x="947"
              y="105"
              textAnchor="middle"
              className="x-t2"
              fontSize="10"
            >
              {shared
                ? "ONE SOURCE · TWO CONNECTED TICKETS"
                : "THIS SOURCE IS LINKED TO T-12"}
            </text>
          </g>
          <g transform="translate(830 0)" aria-hidden="true">
            <Ink part={plates.archive.packetBack} />
            {packed.map((key, index) => (
              <g
                key={key}
                className="fp-manifest-tab"
                transform={`translate(${19 + index * 20} ${212 - index * 2})`}
              >
                <rect width="18" height="69" className="x-p x-i" />
                <rect x="3" y="4" width="12" height="3" className="x-a" />
              </g>
            ))}
            <g className="fp-linked-paper" key={`${selected}-${packRun}`}>
              <Ink part={plates.archive.packetPaper} />
              <text
                x="58"
                y="247"
                fontSize="7.5"
                textAnchor="middle"
                className="x-tp"
              >
                {sourceLabels[packetSource]}
              </text>
            </g>
            <Ink part={plates.archive.packetFront} />
            <text
              x="56"
              y="309"
              fontSize="12"
              className="x-t"
              textAnchor="middle"
            >
              T-12
            </text>
            <text
              x="56"
              y="293"
              fontSize="6.8"
              className="x-ta"
              textAnchor="middle"
            >
              {packRun
                ? "READY FOR NEXT SESSION"
                : `${packed.length} RECORDS SELECTED`}
            </text>
          </g>
          <g transform="translate(1002 0)">
            <g className="fp-shared-ticket">
              <g aria-hidden="true" data-linked={shared}>
                <Ink part={plates.archive.packetBack} />
                <Ink part={plates.archive.packetPaper} />
                <text
                  x="58"
                  y="247"
                  fontSize="7.5"
                  textAnchor="middle"
                  className="x-tp"
                >
                  SPEC
                </text>
                <Ink part={plates.archive.packetFront} />
                <text
                  x="56"
                  y="309"
                  fontSize="12"
                  className="x-t"
                  textAnchor="middle"
                >
                  T-13
                </text>
                <text
                  x="56"
                  y="293"
                  fontSize="6.8"
                  className="x-t2"
                  textAnchor="middle"
                >
                  SHARED SPECIFICATION
                </text>
              </g>
            </g>
          </g>
          <g className="fp-packer"></g>
          {packRun > 0 && (
            <g key={packRun} className="fp-pack-pass" aria-hidden="true">
              <path
                className="x-sa fp-pack-route"
                d="M676 232V202Q676 190 688 190H853Q865 190 865 203V215"
              />
              <g className="fp-transfer-slip">
                <rect
                  x="682"
                  y="180"
                  width="32"
                  height="23"
                  className="x-p x-i"
                />
                <rect x="686" y="184" width="24" height="4" className="x-a" />
                <path
                  d="M686 192H707M686 196H701"
                  className="x-i"
                  fill="none"
                  strokeWidth=".7"
                />
              </g>
              <g className="fp-seal">
                <rect x="865" y="270" width="58" height="15" className="x-a" />
                <text
                  x="894"
                  y="280.5"
                  fontSize="8"
                  textAnchor="middle"
                  className="x-tp"
                >
                  ✓ READY
                </text>
              </g>
            </g>
          )}
        </svg>
      </div>
      <p className="fp-pan-hint" aria-hidden="true">
        ↔ Pan to explore the drawing
      </p>
    </figure>
  );
}

export function AssistantWorkbench({
  source,
  sources,
  questionIndex,
  draft,
  automation,
  notice,
}: {
  source: ContextKey;
  sources: readonly ContextKey[];
  questionIndex: number;
  draft: "none" | "preview" | "added";
  automation: boolean;
  notice: boolean;
}) {
  return (
    <figure
      className="fp-figure fp-assistant"
      data-draft={draft}
      data-automation={automation}
      data-notice={notice}
    >
      <div className="fp-scroll">
        <svg
          className="x-art fp-scene"
          viewBox="20 20 1160 300"
          aria-hidden="true"
          style={
            {
              "--question-angle": `${-110 + questionIndex * 110}deg`,
            } as CSSProperties
          }
        >
          <Ink part={plates.assistant.body} />
          <g
            aria-hidden="true"
            key={`${questionIndex}-${source}`}
            className="fp-answer-trace"
          >
            <path
              className="x-sa fp-flow-path"
              d="M328 150H354Q365 150 365 161V180Q365 190 377 190H410"
            />
            <text x="438" y="104" fontSize="8" className="x-t2">
              LOGIN HARDENING / T-12
            </text>
            <text x="438" y="125" fontSize="11" className="x-ta">
              {
                ["WHAT CHANGED?", "WHY THIS LIMIT?", "WHAT COMES NEXT?"][
                  questionIndex
                ]
              }
            </text>
            <text x="438" y="143" fontSize="8.5" className="x-t">
              {
                [
                  "PR #87 · Ready for review",
                  "Account + IP · 5 / 15m",
                  "Review against the spec",
                ][questionIndex]
              }
            </text>
            <line
              x1="438"
              x2="565"
              y1="152"
              y2="152"
              className="x-i"
              strokeWidth=".7"
            />
            <text x="438" y="167" fontSize="7" className="x-t2">
              SOURCE / {sourceLabels[source]}
            </text>
          </g>
          {contextKeys.map((key, index) => (
            <g key={key} transform={`translate(${110 + index * 45} 100)`}>
              <g
                className="fp-source-file"
                data-selected={source === key}
                data-muted={!sources.includes(key)}
              >
                <g className="fp-file-slide" aria-hidden="true">
                  <Ink part={plates.assistant.file} />
                  <text
                    x="20"
                    y="21"
                    fontSize="5.6"
                    textAnchor="middle"
                    className="x-tp"
                  >
                    {sourceLabels[key]}
                  </text>
                  <text
                    x="19"
                    y="-1"
                    fontSize="5.4"
                    textAnchor="middle"
                    className="x-t2"
                  >
                    0{index + 1}
                  </text>
                </g>
              </g>
            </g>
          ))}
          <g transform="translate(823 96)">
            <g className="fp-draft-tray">
              <g className="fp-draft-paper" aria-hidden="true">
                <Ink part={plates.assistant.draft} />
                <text
                  x="54"
                  y="22"
                  fontSize="9"
                  className="x-tp"
                  textAnchor="middle"
                >
                  {draft === "added"
                    ? "T-18 / ADDED"
                    : draft === "preview"
                      ? "REVIEW DRAFT"
                      : "NEXT STEP"}
                </text>
                <text
                  x="54"
                  y="90"
                  fontSize="5.6"
                  className="x-t2"
                  textAnchor="middle"
                >
                  {draft === "added"
                    ? "LOGIN HARDENING PLAN"
                    : draft === "preview"
                      ? "AWAITING YOUR REVIEW"
                      : "IDEAS BECOME TICKETS"}
                </text>
              </g>
            </g>
          </g>
          <g className="fp-approval-stamp">
            <g className="fp-stamp-head">
              <Ink part={plates.assistant.stamp} />
            </g>
          </g>
          <g className="fp-relay">
            <g aria-hidden="true">
              <circle cx="974" cy="116" r="5" className="x-p x-i" />
              <path
                d="M974 116L987 100"
                className="x-i fp-relay-lever"
                strokeWidth="3"
              />
              <circle cx="989" cy="116" r="3" className="x-p x-i" />
              <text
                x="981"
                y="134"
                fontSize="6"
                textAnchor="middle"
                className="x-t2"
              >
                {automation ? "ON" : "OFF"}
              </text>
            </g>
          </g>
          <g className="fp-test-relay"></g>
          {notice && (
            <g className="fp-notice" aria-hidden="true">
              <path className="x-sa fp-flow-path" d="M1025 114H1074" />
              <rect
                x="951"
                y="28"
                width="157"
                height="22"
                className="x-p x-i"
              />
              <text
                x="1029"
                y="42.5"
                textAnchor="middle"
                fontSize="8.5"
                className="x-ta"
              >
                T-12 / READY FOR REVIEW
              </text>
            </g>
          )}
        </svg>
      </div>
      <p className="fp-pan-hint" aria-hidden="true">
        ↔ Pan to explore the drawing
      </p>
    </figure>
  );
}
