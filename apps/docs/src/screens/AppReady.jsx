import { Component, Fragment } from "react";
import markup from "./AppReady.markup.json";
export default class AppReady extends Component {
  constructor(...args) {
    super(...args);
    this.state = { zoom: 1 };
    this.setBox = (el) => {
      if (this.ro) this.ro.disconnect();
      this.box = el;
      if (!el || typeof ResizeObserver === "undefined") return;
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(el);
      this.measure();
    };
  }

  componentWillUnmount() {
    if (this.ro) this.ro.disconnect();
  }

  measure() {
    if (!this.box) return;
    const crop = this.crop();
    const zoom = Math.min(1.2, Math.max(0.2, this.box.clientWidth / crop[2]));
    if (Math.abs(zoom - this.state.zoom) > 0.002) this.setState({ zoom });
  }

  // A crop shows one part of the window, [x, y, width, height] in the app's own pixels.
  crop() {
    const c = (this.props || {}).crop;
    return Array.isArray(c) && c.length === 4 ? c : [0, 0, 1280, 772];
  }

  // The rows come out in the app's order (newest reference first) whatever order the page passes.
  renderVals() {
    const p = this.props || {};
    const ready = Array.isArray(p.ready)
      ? p.ready
      : ["T-14", "T-11", "T-8", "T-6", "T-5", "T-4"];
    const fresh = Array.isArray(p.fresh) ? p.fresh : [];
    const on = {};
    const isFresh = {};
    [
      "T-14",
      "T-13",
      "T-12",
      "T-11",
      "T-10",
      "T-8",
      "T-7",
      "T-6",
      "T-5",
      "T-4",
    ].forEach((ref) => {
      const k = ref.replace("-", "");
      on[k] = ready.indexOf(ref) !== -1;
      isFresh[k] = fresh.indexOf(ref) !== -1;
    });
    const dark = p.theme === "dark";
    const crop = this.crop();
    return {
      clipW: String(crop[2]),
      clipH: String(crop[3]),
      cropX: String(-crop[0]),
      cropY: String(-crop[1]),
      on,
      fresh: isFresh,
      count: String(ready.length),
      theme: dark ? "dark" : "light",
      darkClass: dark ? " dark" : "",
      yes: true,
      setBox: this.setBox,
      zoom: String(this.state.zoom),
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <>
        <div className={"aw"} ref={v.setBox}>
          <div className={"aw-zoom"} style={{ zoom: v.zoom }}>
            <div
              className={"aw-clip"}
              style={{ width: v.clipW + "px", height: v.clipH + "px" }}
            >
              <div
                className={"aw-move"}
                style={{
                  transform: "translate(" + v.cropX + "px, " + v.cropY + "px)",
                }}
              >
                <div
                  className={"app" + v.darkClass}
                  data-theme={v.theme}
                  data-input={"pointer"}
                  data-window-bar={""}
                  aria-hidden={"true"}
                  inert={true}
                  style={{
                    width: "1280px",
                    height: "772px",
                    "--app-vh": "772px",
                    "--app-vw": "1280px",
                  }}
                >
                  <div>
                    <div
                      data-slot={"sidebar-wrapper"}
                      className={
                        "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar"
                      }
                      style={{
                        "--sidebar-width": "14rem",
                        "--sidebar-width-icon": "3rem",
                      }}
                    >
                      <div
                        className={"window-bar"}
                        dangerouslySetInnerHTML={{ __html: markup[0] }}
                      />
                      <div className={"workspace"}>
                        <div
                          data-slot={"sidebar"}
                          className={
                            "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground sidebar"
                          }
                        >
                          <div
                            data-slot={"sidebar-header"}
                            data-sidebar={"header"}
                            className={"flex flex-col gap-2 p-2 sidebar-header"}
                            dangerouslySetInnerHTML={{ __html: markup[1] }}
                          />
                          <div
                            data-slot={"sidebar-content"}
                            data-sidebar={"content"}
                            className={
                              "flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto group-data-[collapsible=icon]:overflow-hidden sidebar-body"
                            }
                          >
                            <nav
                              aria-label={"Workspace views"}
                              className={"sidebar-nav"}
                            >
                              <ul
                                data-slot={"sidebar-menu"}
                                data-sidebar={"menu"}
                                className={"flex w-full min-w-0 flex-col gap-1"}
                              >
                                <li
                                  data-slot={"sidebar-menu-item"}
                                  data-sidebar={"menu-item"}
                                  className={"group/menu-item relative"}
                                  dangerouslySetInnerHTML={{
                                    __html: markup[2],
                                  }}
                                />
                                <li
                                  data-slot={"sidebar-menu-item"}
                                  data-sidebar={"menu-item"}
                                  className={"group/menu-item relative"}
                                  dangerouslySetInnerHTML={{
                                    __html: markup[3],
                                  }}
                                />
                                <li
                                  data-slot={"sidebar-menu-item"}
                                  data-sidebar={"menu-item"}
                                  className={"group/menu-item relative"}
                                >
                                  <button
                                    data-slot={"sidebar-menu-button"}
                                    data-sidebar={"menu-button"}
                                    data-size={"default"}
                                    data-active={"true"}
                                    className={
                                      "ui-navigation-button peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8 text-sm"
                                    }
                                    data-state={"closed"}
                                    aria-current={"page"}
                                  >
                                    <svg
                                      width={"16"}
                                      height={"16"}
                                      viewBox={"0 0 24 24"}
                                      fill={"none"}
                                      stroke={"currentColor"}
                                      strokeWidth={"2"}
                                      strokeLinecap={"round"}
                                      strokeLinejoin={"round"}
                                      className={
                                        "lucide lucide-circle-play lucide-play-circle"
                                      }
                                    >
                                      <path
                                        d={
                                          "M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"
                                        }
                                      ></path>
                                      <circle
                                        cx={"12"}
                                        cy={"12"}
                                        r={"10"}
                                      ></circle>
                                    </svg>
                                    {" Ready "}
                                    <span className={"sidebar-count"}>
                                      {v.count}
                                    </span>
                                  </button>
                                </li>
                                <li
                                  data-slot={"sidebar-menu-item"}
                                  data-sidebar={"menu-item"}
                                  className={"group/menu-item relative"}
                                  dangerouslySetInnerHTML={{
                                    __html: markup[4],
                                  }}
                                />
                              </ul>
                            </nav>
                            <span role={"status"} className={"sr-only"}></span>
                            <div
                              className={"sidebar-scroll"}
                              dangerouslySetInnerHTML={{ __html: markup[5] }}
                            />
                          </div>
                          <div
                            data-slot={"sidebar-footer"}
                            data-sidebar={"footer"}
                            className={"flex flex-col gap-2 p-2 sidebar-footer"}
                            dangerouslySetInnerHTML={{ __html: markup[6] }}
                          />
                        </div>
                        <main tabIndex={"-1"} className={"content-panel"}>
                          <div className={"plan-workspace"}>
                            <div
                              data-slot={"resizable-panel-group"}
                              className={
                                "flex h-full w-full aria-[orientation=vertical]:flex-col ticket-workspace board-unselected"
                              }
                              style={{
                                height: "100%",
                                width: "100%",
                                overflow: "hidden",
                                display: "flex",
                                flexFlow: "row",
                                touchAction: "pan-y",
                              }}
                            >
                              <div
                                data-slot={"resizable-panel"}
                                style={{
                                  minHeight: "0px",
                                  maxHeight: "100%",
                                  height: "auto",
                                  minWidth: "0px",
                                  maxWidth: "100%",
                                  width: "auto",
                                  border: "0px",
                                  padding: "0px",
                                  margin: "0px",
                                  display: "flex",
                                  flex: "36.676 1 0px",
                                  overflow: "visible",
                                }}
                              >
                                <div
                                  style={{
                                    maxHeight: "100%",
                                    maxWidth: "100%",
                                    flexGrow: "1",
                                    overflow: "auto",
                                    touchAction: "pan-y",
                                  }}
                                >
                                  <section
                                    className={"ticket-list"}
                                    tabIndex={"-1"}
                                  >
                                    <div className={"list-header"}>
                                      <h1 tabIndex={"-1"}>{"Ready"}</h1>
                                      <p>
                                        {v.count}
                                        <span className={"sr-only"}>
                                          {" tickets"}
                                        </span>
                                      </p>
                                      <button
                                        data-slot={"tooltip-trigger"}
                                        data-variant={"ghost"}
                                        data-size={"icon-sm"}
                                        className={
                                          "ui-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4 ui-button-ghost size-8 list-refresh"
                                        }
                                        aria-label={"Refresh"}
                                        data-state={"closed"}
                                        dangerouslySetInnerHTML={{
                                          __html: markup[7],
                                        }}
                                      />
                                      <div
                                        className={"list-controls"}
                                        dangerouslySetInnerHTML={{
                                          __html: markup[8],
                                        }}
                                      />
                                      <button
                                        data-slot={"popover-trigger"}
                                        data-variant={"ghost"}
                                        data-size={"sm"}
                                        className={
                                          "ui-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4 ui-button-ghost h-8 px-3"
                                        }
                                        type={"button"}
                                        aria-haspopup={"dialog"}
                                        aria-expanded={"false"}
                                        data-state={"closed"}
                                        dangerouslySetInnerHTML={{
                                          __html: markup[9],
                                        }}
                                      />
                                    </div>
                                    <p className={"list-description"}>
                                      {
                                        "Todo tickets with nothing left to wait on."
                                      }
                                    </p>
                                    <div className={"ticket-scroll"}>
                                      <ul className={"ticket-rows"}>
                                        {v.on.T14 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T14}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[10],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T13 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T13}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[11],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T12 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T12}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[12],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T11 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T11}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[13],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T10 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T10}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[14],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T8 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T8}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[15],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T7 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T7}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[16],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T6 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T6}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[17],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T5 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T5}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[18],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                        {v.on.T4 ? (
                                          <>
                                            <li
                                              data-fresh={v.fresh.T4}
                                              dangerouslySetInnerHTML={{
                                                __html: markup[19],
                                              }}
                                            />
                                          </>
                                        ) : null}
                                      </ul>
                                    </div>
                                  </section>
                                </div>
                              </div>
                              <div
                                data-slot={"resizable-handle"}
                                aria-label={"Resize ticket list"}
                                aria-orientation={"vertical"}
                                className={
                                  "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90 split-handle"
                                }
                                role={"separator"}
                                tabIndex={"0"}
                                style={{
                                  flex: "0 0 auto",
                                  touchAction: "none",
                                }}
                              ></div>
                              <div
                                data-slot={"resizable-panel"}
                                style={{
                                  minHeight: "0px",
                                  maxHeight: "100%",
                                  height: "auto",
                                  minWidth: "0px",
                                  maxWidth: "100%",
                                  width: "auto",
                                  border: "0px",
                                  padding: "0px",
                                  margin: "0px",
                                  display: "flex",
                                  flex: "63.324 1 0px",
                                  overflow: "visible",
                                }}
                                dangerouslySetInnerHTML={{ __html: markup[20] }}
                              />
                            </div>
                          </div>
                        </main>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }
}
