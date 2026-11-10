import { Component } from "react";
import markup from "./AppDock.markup.json";
export default class AppDock extends Component {
  constructor(...args) {
    super(...args);
    this.state = { zoom: 1 };
    this.box = null;
    this.setBox = (el) => {
      if (this.ro) this.ro.disconnect();
      this.box = el;
      if (!el || typeof ResizeObserver === "undefined") return;
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(el);
      this.measure();
    };
  }

  navAt(event) {
    if (!this.box || !event) return null;
    const els = this.box.querySelectorAll("[data-nav]");
    for (let i = 0; i < els.length; i += 1) {
      const r = els[i].getBoundingClientRect();
      if (
        r.width &&
        event.clientX >= r.left &&
        event.clientX <= r.right &&
        event.clientY >= r.top &&
        event.clientY <= r.bottom
      )
        return els[i];
    }
    return null;
  }

  navBox(el) {
    const app = this.box && this.box.querySelector(".app");
    if (!el || !app) return null;
    const a = app.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const k = a.width / 1280;
    return {
      left: Math.round((r.left - a.left) / k),
      top: Math.round((r.top - a.top) / k),
      w: Math.round(r.width / k),
      h: Math.round(r.height / k),
      id: el.getAttribute("data-nav"),
    };
  }

  componentWillUnmount() {
    if (this.ro) this.ro.disconnect();
  }

  // The app keeps its own 1280 px layout and is zoomed to fit the frame it sits in.
  measure() {
    if (!this.box) return;
    const zoom = Math.min(1, Math.max(0.2, this.box.clientWidth / 1280));
    if (Math.abs(zoom - this.state.zoom) > 0.002) this.setState({ zoom });
  }

  renderVals() {
    const p = this.props || {};
    const RECTS = {
      tickets: { gh: [224, 128, 384, 712] },
      imported: { source: [609, 40, 663, 724] },
      publish: { dialog: [40, -110, 600, 413] },
      projects: { project: [308, 232, 880, 108] },
      github: { card: [368, 352, 760, 424] },
      backups: { backup: [388, 168, 720, 268] },
      export: { export: [388, 244, 720, 200] },
    };
    const screen = RECTS[p.screen] ? p.screen : "tickets";
    const is = {};
    Object.keys(RECTS).forEach((k) => {
      is[k] = k === screen;
    });
    const dark = p.theme === "dark";
    const r = (RECTS[screen] || {})[p.hl];
    const view = Number(p.view) || 772;
    // A tall screen shows a window of it, moved so the highlighted part is in view.
    const offset =
      r && view < 772
        ? Math.max(0, Math.min(772 - view, r[1] - Math.round(view * 0.22)))
        : 0;
    const nav = this.state.nav;
    return {
      navClick: (event) => {
        const el = this.navAt(event);
        if (el && typeof p.go === "function") p.go(el.getAttribute("data-nav"));
      },
      navHover: (event) => {
        const b = this.navBox(this.navAt(event));
        const cur = this.state.nav;
        if ((b && b.id + b.top) !== (cur && cur.id + cur.top))
          this.setState({ nav: b });
      },
      navLeave: () => {
        if (this.state.nav) this.setState({ nav: null });
      },
      navOver: !!nav,
      hasNav: !!nav,
      navLeft: nav ? String(nav.left - 3) : "0",
      navTop: nav ? String(nav.top - 3) : "0",
      navW: nav ? String(nav.w + 6) : "0",
      navH: nav ? String(nav.h + 6) : "0",
      is,
      theme: dark ? "dark" : "light",
      darkClass: dark ? " dark" : "",
      yes: true,
      setBox: this.setBox,
      zoom: String(this.state.zoom),
      viewH: String(view),
      shift: String(-offset),
      hasHl: !!r,
      hlLeft: r ? String(r[0] - 6) : "0",
      hlTop: r ? String(r[1] - 6) : "0",
      hlW: r ? String(r[2] + 12) : "0",
      hlH: r ? String(r[3] + 12) : "0",
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <>
        <div
          className={"aw"}
          ref={v.setBox}
          data-over={v.navOver}
          onClick={v.navClick}
          onPointerMove={v.navHover}
          onPointerLeave={v.navLeave}
        >
          <div className={"aw-zoom"} style={{ zoom: v.zoom }}>
            <div className={"aw-clip"} style={{ height: v.viewH + "px" }}>
              <div
                className={"aw-move"}
                style={{ transform: "translateY(" + v.shift + "px)" }}
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
                  {v.is.tickets ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[0] }} />
                    </>
                  ) : null}
                  {v.is.imported ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[1] }} />
                    </>
                  ) : null}
                  {v.is.publish ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[2] }} />
                      <div
                        data-state={"open"}
                        data-slot={"dialog-overlay"}
                        className={"ui-overlay fixed inset-0 z-50"}
                        aria-hidden={"true"}
                        style={{ pointerEvents: "auto" }}
                      ></div>
                      <div
                        role={"dialog"}
                        data-state={"open"}
                        data-slot={"dialog-content"}
                        className={
                          "ui-dialog fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 p-6 outline-none sm:max-w-lg publication-dialog publish-dialog"
                        }
                        tabIndex={"-1"}
                        style={{ pointerEvents: "auto" }}
                        dangerouslySetInnerHTML={{ __html: markup[3] }}
                      />
                    </>
                  ) : null}
                  {v.is.projects ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[4] }} />
                      <div
                        data-radix-popper-content-wrapper={""}
                        style={{
                          position: "fixed",
                          left: "0px",
                          top: "0px",
                          transform: "translate(144px, 190px)",
                          minWidth: "max-content",
                          "--radix-popper-transform-origin": "58px 38px",
                          zIndex: "50",
                          "--radix-popper-available-width": "1280px",
                          "--radix-popper-available-height": "218px",
                          "--radix-popper-anchor-width": "28px",
                          "--radix-popper-anchor-height": "28px",
                        }}
                        dangerouslySetInnerHTML={{ __html: markup[5] }}
                      />
                    </>
                  ) : null}
                  {v.is.github ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[6] }} />
                    </>
                  ) : null}
                  {v.is.backups ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[7] }} />
                    </>
                  ) : null}
                  {v.is.export ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[8] }} />
                    </>
                  ) : null}
                </div>
                {v.hasNav ? (
                  <>
                    <span
                      className={"aw-nav"}
                      style={{
                        left: v.navLeft + "px",
                        top: v.navTop + "px",
                        width: v.navW + "px",
                        height: v.navH + "px",
                      }}
                    ></span>
                  </>
                ) : null}
                {v.hasHl ? (
                  <>
                    <span
                      className={"aw-hl"}
                      style={{
                        left: v.hlLeft + "px",
                        top: v.hlTop + "px",
                        width: v.hlW + "px",
                        height: v.hlH + "px",
                      }}
                    ></span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }
}
