import { Component, Fragment } from "react";
import markup from "./AppMonitor.markup.json";
export default class AppMonitor extends Component {
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
      tickets0: {},
      tickets1: {},
      tickets2: {},
      tickets3: {},
      plan0: {},
      plan1: {},
      plan2: {},
      plan3: {},
      graph0: {},
      graph1: {},
      graph2: {},
      graph3: {},
      ticket0: {},
      ticket1: {},
      ticket2: {},
      ticket3: {},
      inbox0: {},
      inbox1: {},
      inbox2: {},
      inbox3: {},
    };
    const screen = RECTS[p.screen] ? p.screen : "plan0";
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
                  {v.is.tickets0 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[0] }} />
                    </>
                  ) : null}
                  {v.is.tickets1 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[1] }} />
                    </>
                  ) : null}
                  {v.is.tickets2 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[2] }} />
                    </>
                  ) : null}
                  {v.is.tickets3 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[3] }} />
                    </>
                  ) : null}
                  {v.is.plan0 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[4] }} />
                    </>
                  ) : null}
                  {v.is.plan1 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[5] }} />
                    </>
                  ) : null}
                  {v.is.plan2 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[6] }} />
                    </>
                  ) : null}
                  {v.is.plan3 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[7] }} />
                    </>
                  ) : null}
                  {v.is.graph0 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[8] }} />
                    </>
                  ) : null}
                  {v.is.graph1 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[9] }} />
                    </>
                  ) : null}
                  {v.is.graph2 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[10] }} />
                    </>
                  ) : null}
                  {v.is.graph3 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[11] }} />
                    </>
                  ) : null}
                  {v.is.ticket0 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[12] }} />
                    </>
                  ) : null}
                  {v.is.ticket1 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[13] }} />
                    </>
                  ) : null}
                  {v.is.ticket2 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[14] }} />
                    </>
                  ) : null}
                  {v.is.ticket3 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[15] }} />
                    </>
                  ) : null}
                  {v.is.inbox0 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[16] }} />
                    </>
                  ) : null}
                  {v.is.inbox1 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[17] }} />
                    </>
                  ) : null}
                  {v.is.inbox2 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[18] }} />
                    </>
                  ) : null}
                  {v.is.inbox3 ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[19] }} />
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
