import { Component, Fragment } from "react";
import markup from "./AppLine.markup.json";
export default class AppLine extends Component {
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
      spec: { doc: [224, 88, 776, 676] },
      plan: { plan: [224, 40, 1048, 145] },
      create: { rows: [224, 229, 384, 212] },
      wire: { chain: [248, 632, 1000, 108] },
      update: {
        status: [1040, 233, 232, 531],
        activity: [1060, 345, 192, 68],
        evidence: [641, 613, 367, 64],
      },
    };
    const screen = RECTS[p.screen] ? p.screen : "spec";
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
    return {
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
        <div className={"aw"} ref={v.setBox}>
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
                  {v.is.spec ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[0] }} />
                    </>
                  ) : null}
                  {v.is.plan ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[1] }} />
                    </>
                  ) : null}
                  {v.is.create ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[2] }} />
                    </>
                  ) : null}
                  {v.is.wire ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[3] }} />
                    </>
                  ) : null}
                  {v.is.update ? (
                    <>
                      <div dangerouslySetInnerHTML={{ __html: markup[4] }} />
                    </>
                  ) : null}
                </div>
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
