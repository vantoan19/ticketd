import { Component, Fragment } from "react";
import { links } from "./links";
import markup from "./Landing.markup.json";
import AppReady from "./screens/AppReady";
import AppLine from "./screens/AppLine";
import AppMonitor from "./screens/AppMonitor";
import AppTicket from "./screens/AppTicket";
import AppDock from "./screens/AppDock";
export default class Landing extends Component {
  constructor(...args) {
    super(...args);
    this.state = {
      theme: null,
      focus: "top",
      heroRun: "idle",
      heroMade: false,
      heroRead: false,
      heroLast: null,
      heroPhase: "idle",
      heroK: "a",
      lineStep: -1,
      lineDone: -1,
      linePhase: "idle",
      linePrinted: 0,
      lineWho: "agent",
      lineAuto: false,
      monK: 0,
      monCh: "plan",
      monPlaying: false,
      monFlick: "a",
      monLive: false,
      done: null,
      plug: null,
      picked: null,
      dispLog: null,
      dispMood: "idle",
      dispFresh: [],
      scopes: null,
      lastScope: "latest",
      ship: "none",
      shipped: false,
      bay: "github",
      ghView: "tickets",
      opened: null,
      hot: { hero: "", line: "", asm: "", dock: "" },
      inView: null,
      drag: null,
      dispEcho: [],
      copied: "",
      startPhase: "idle",
      startTyped: 14,
      startLines: 15,
      footPunch: false,
    };
    this.startTimers = [];
    this.heroTimers = [];
    this.flips = {};
    this.timers = [];
    this.lineTimers = [];
    this.monTimer = null;
    this.played = {};
    this.viewRefs = {};
    this.onScheme = () => this.forceUpdate();
    this.state.cables = {};
    this.state.pulse = {
      line: "none",
      disp: "none",
      asm: "none",
      dock: "none",
    };
    // Cables follow the gutter between a drawing and the app window it feeds.
    this.setRoot = (el) => {
      if (this.ro) this.ro.disconnect();
      this.root = el;
      if (!el || typeof ResizeObserver === "undefined") return;
      this.ro = new ResizeObserver(() => this.measureCables());
      this.ro.observe(el);
      this.setupSpy(el);
    };
  }

  measureCables() {
    const root = this.root;
    if (!root) return;
    const out = {};
    root.querySelectorAll("[data-cable-from]").forEach((from) => {
      const key = from.getAttribute("data-cable-from");
      const to = root.querySelector('[data-cable-to="' + key + '"]');
      const sec = from.closest(".st-sec");
      if (!to || !sec) return;
      const S = sec.getBoundingClientRect();
      const k = S.width / Math.max(1, sec.offsetWidth);
      if (sec.offsetWidth < 760) {
        out[key] = "";
        return;
      }
      const F = from.getBoundingClientRect();
      const T = to.getBoundingClientRect();
      const r = 10;
      const fx = Math.round((Math.min(F.right, S.right) - S.left) / k);
      const y1 = Math.round(
        (F.top -
          S.top +
          F.height * Number(from.getAttribute("data-cable-y") || 0.5)) /
          k,
      );
      const gx = Math.round(
        sec.offsetWidth - parseFloat(getComputedStyle(sec).paddingRight) / 2,
      );
      const tx = Math.round((T.right - S.left) / k) + 1;
      const y2 = Math.round((T.top - S.top) / k) + 14;
      if (T.left > F.right) {
        const left = Math.round((T.left - S.left) / k) - 1;
        const middle = Math.round((fx + left) / 2);
        out[key] = `M${fx} ${y1}H${middle}V${y2}H${left}`;
        return;
      }
      out[key] =
        "M" +
        fx +
        " " +
        y1 +
        "H" +
        (gx - r) +
        "Q" +
        gx +
        " " +
        y1 +
        " " +
        gx +
        " " +
        (y1 + r) +
        "V" +
        (y2 - r) +
        "Q" +
        gx +
        " " +
        y2 +
        " " +
        (gx - r) +
        " " +
        y2 +
        "H" +
        tx;
    });
    if (JSON.stringify(out) !== JSON.stringify(this.state.cables || {}))
      this.setState({ cables: out });
  }

  pulseOf(key) {
    const p = this.state.pulse || {};
    return Object.assign({}, p, { [key]: p[key] === "a" ? "b" : "a" });
  }

  componentDidMount() {
    try {
      this.scheme = window.matchMedia("(prefers-color-scheme: dark)");
      this.scheme.addEventListener("change", this.onScheme);
    } catch {
      this.scheme = null;
    }
    if ((this.props || {}).autoplay !== false) {
      if (this.reduced()) {
        const lastLineStep = this.data().LINE.length - 1;
        this.setState({
          heroMade: true,
          heroRead: true,
          heroLast: "read",
          heroPhase: "read-done",
          lineStep: lastLineStep,
          lineDone: lastLineStep,
          linePrinted: this.data().LINE[lastLineStep].term.length,
          monK: 3,
          opened: { github: true },
          startPhase: "done",
          startTyped: 14,
          startLines: this.data().HELP.length,
          footPunch: true,
        });
      } else this.heroAutoTimer = setTimeout(() => this.heroDemo(), 800);
    }
    this.later(60, () => this.measureCables());
    try {
      document.fonts.ready.then(() => this.measureCables());
    } catch {
      /* no font loading API */
    }
  }

  componentWillUnmount() {
    this.timers.forEach((id) => clearTimeout(id));
    this.heroTimers.forEach((id) => clearTimeout(id));
    clearTimeout(this.heroAutoTimer);
    this.lineTimers.forEach((id) => clearTimeout(id));
    clearInterval(this.monTimer);
    clearTimeout(this.liveTimer);
    clearTimeout(this.shipTimer);
    if (this.ro) this.ro.disconnect();
    if (this.spy) this.spy.disconnect();
    clearTimeout(this.copyTimer);
    this.startTimers.forEach((id) => clearTimeout(id));
    if (this.io) this.io.disconnect();
    if (this.scheme) this.scheme.removeEventListener("change", this.onScheme);
  }

  later(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  }

  reduced() {
    if ((this.props || {}).motion === "reduce") return true;
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  // Each figure plays once, the first time it scrolls into view.
  view(name) {
    if (!this.viewRefs[name]) {
      this.viewRefs[name] = (el) => {
        if (
          !el ||
          this.played[name] ||
          this.reduced() ||
          (this.props || {}).autoplay === false
        )
          return;
        if (typeof IntersectionObserver === "undefined") {
          this.onView(name);
          return;
        }
        if (!this.io) {
          this.io = new IntersectionObserver(
            (entries) =>
              entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                this.io.unobserve(entry.target);
                this.onView(entry.target.getAttribute("data-view"));
              }),
            { threshold: 0.3 },
          );
        }
        this.io.observe(el);
      };
    }
    return this.viewRefs[name];
  }

  onView(name) {
    if (this.played[name]) return;
    this.played[name] = true;
    if (name === "line") this.later(300, () => this.runLine());
    if (name === "monitor") this.later(500, () => this.playShift(true));
    if (name === "dock") this.later(400, () => this.openBay("github"));
    if (name === "start") this.later(300, () => this.runStart());
    if (name === "foot") this.setState({ footPunch: true });
  }

  // Everything the page prints, recorded from the ticketd CLI built from main (5c1a242).
  data() {
    if (this._data) return this._data;
    const cmd = (text) => ({ cls: "st-tl st-tl-cmd", prompt: "$ ", text });
    const cont = (text) => ({ cls: "st-tl st-tl-cmd", prompt: "  ", text });
    const out = (text) => ({ cls: "st-tl st-tl-out", prompt: "", text });
    const note = (text) => ({ cls: "st-tl st-tl-note", prompt: "", text });
    const SPEC = "50ea2963-1191-47c0-9f20-32b2cb906fa1";
    const PLAN = "c57b2a5e-b688-4b21-a9a7-f9f37b5471f6";
    const NOTES = "d0db3192-e25d-4f3c-8864-c0929e1f95cf";
    const U1 =
      "Added a sliding-window limiter: 5 failures per 15 minutes by account and IP. Next: show the wait time on the login form.";
    const U2 = "Limiter tests pass on CI. Opened #87 for review.";
    const LINE = [
      {
        id: "spec",
        num: "01",
        name: "Spec",
        cmdHint: "document create",
        screen: "spec",
        hl: "doc",
        app: "Documents",
        say: "The agent writes the spec as a Document.",
        cap: "The spec, readable in Documents the moment it’s written.",
        term: [
          cmd('ticketd document create --title "Login hardening spec" \\'),
          cont("    --body-file spec.md | jq -r .id"),
          out(SPEC),
        ],
        you: [
          note("# In the app: Documents › New Document, then write the spec."),
        ],
      },
      {
        id: "plan",
        num: "02",
        name: "Plan",
        cmdHint: "plan create, plan spec",
        screen: "plan",
        hl: "plan",
        app: "Login hardening",
        say: "A Plan groups the work; the spec becomes its spec.",
        cap: "An active Plan with the spec attached and no tickets yet.",
        term: [
          cmd('ticketd plan create "Login hardening" | jq -r .id'),
          out(PLAN),
          note("# PLAN and SPEC hold the ids printed above"),
          cmd('ticketd plan spec "$PLAN" "$SPEC" | jq -r .spec_document_id'),
          out(SPEC),
        ],
        you: [
          note(
            "# In the app: Plans › New Plan, then Spec › choose the Document.",
          ),
        ],
      },
      {
        id: "create",
        num: "03",
        name: "Create",
        cmdHint: "document create-ticket",
        screen: "create",
        hl: "rows",
        app: "Login hardening",
        say: "Three tickets are cut from the spec and added to the Plan.",
        cap: "T-12, T-13 and T-14 in the Plan, all Todo and Ready.",
        term: [
          cmd(
            'ticketd document create-ticket "$SPEC" "Rate-limit failed login attempts" | jq -r .reference',
          ),
          out("T-12"),
          cmd(
            'ticketd document create-ticket "$SPEC" "Alert on-call when failed logins spike" | jq -r .reference',
          ),
          out("T-13"),
          cmd(
            'ticketd document create-ticket "$SPEC" "Show the remaining wait time on the login form" | jq -r .reference',
          ),
          out("T-14"),
          cmd(
            'for t in T-12 T-13 T-14; do ticketd plan add "$PLAN" $t --agent coding-agent > /dev/null; done',
          ),
        ],
        you: [
          note(
            "# In the app: the spec’s Create ticket from this, then Add to a Plan.",
          ),
        ],
      },
      {
        id: "wire",
        num: "04",
        name: "Wire",
        cmdHint: "add-dependency, set-parent",
        screen: "wire",
        hl: "chain",
        app: "Login hardening · Dependencies",
        say: "T-13 waits on T-12; T-14 becomes its subticket; T-10 is related.",
        cap: "An arrow from T-12 to T-13, and T-13 is Blocked.",
        term: [
          cmd(
            "ticketd add-dependency T-12 T-13 --agent coding-agent | jq -r .availability",
          ),
          out("Blocked"),
          cmd(
            "ticketd set-parent T-14 --parent T-12 --agent coding-agent | jq -r .parent.reference",
          ),
          out("T-12"),
          cmd(
            "ticketd add-relationship T-12 T-10 related --agent coding-agent | jq -r .reference",
          ),
          out("T-12"),
        ],
        you: [
          note(
            "# In the app: T-13 › Relationships › Add relationship › Blocked by T-12.",
          ),
        ],
      },
      {
        id: "update",
        num: "05",
        name: "Update",
        cmdHint: "change --status, activity add",
        screen: "update",
        hl: "status",
        app: "T-12",
        say: "T-12 goes In progress, with its branch and an update from coding-agent.",
        cap: "In progress, with the latest update credited to coding-agent.",
        term: [
          cmd(
            'ticketd change T-12 --status "In progress" --agent coding-agent | jq -r .status',
          ),
          out("In progress"),
          cmd("ticketd evidence add T-12 --kind branch --name branch \\"),
          cont(
            "    --value feat/login-rate-limit --agent coding-agent | jq -r .value",
          ),
          out("feat/login-rate-limit"),
          cmd(
            "ticketd activity add T-12 --agent coding-agent --file update.md | jq -r .brief",
          ),
          out(U1),
        ],
        you: [
          note(
            "# In the app: T-12 › Status › In progress, then Write an update.",
          ),
          note("# Your own edits don’t ring your Inbox."),
        ],
      },
    ];

    const CHANNELS = [
      { id: "tickets", n: "1", name: "Tickets", hint: "All tickets" },
      { id: "plan", n: "2", name: "Plan", hint: "Login hardening" },
      { id: "graph", n: "3", name: "Graph", hint: "Workspace graph" },
      { id: "ticket", n: "4", name: "Ticket", hint: "T-12" },
      { id: "inbox", n: "5", name: "Inbox", hint: "Followed tickets" },
    ];
    const SHIFT = [
      {
        k: 0,
        t: "00:00",
        who: "coding-agent",
        text: "adds T-9 and T-10 to Login hardening",
        status: "Plan: 0 of 5 done",
      },
      {
        k: 1,
        t: "00:12",
        who: "coding-agent",
        text: "moves T-9 to Done, so T-10 is Ready",
        status: "Plan: 1 of 5 done",
      },
      {
        k: 2,
        t: "00:24",
        who: "coding-agent",
        text: "posts an update on T-12, adds pull request #87 and moves T-12 to In review",
        bell: true,
        status: "Inbox: 2 new",
      },
      {
        k: 3,
        t: "00:38",
        who: "You",
        text: "mark T-12 Done after review. Your own edit doesn’t ring your Inbox",
        status: "Plan: 2 of 5 done",
      },
      {
        k: 3,
        t: "00:39",
        who: "coding-agent",
        text: "starts T-13, now Ready, and posts an update",
        bell: true,
        status: "Inbox: 4 new",
      },
    ];
    const INBOX = [0, 0, 2, 4];
    const INBOX_NOTE = [
      "nothing new",
      "nothing new: T-9 isn’t followed",
      "from coding-agent, on T-12",
      "from coding-agent, on T-12 and T-13",
    ];
    const MON_SR = {
      tickets: [
        "All tickets in the desktop app: T-12 In progress, T-9 In review, T-13 and T-10 Blocked.",
        "All tickets: T-9 Done and T-10 Ready.",
        "All tickets: T-12 In review.",
        "All tickets: T-12 Done and T-13 In progress.",
      ],
      plan: [
        "The Login hardening Plan board: 0 of 5 done.",
        "The Plan board: 1 of 5 done, T-9 in Done.",
        "The Plan board: T-12 in In review.",
        "The Plan board: 2 of 5 done.",
      ],
      graph: [
        "The workspace graph: T-12 blocks T-13, T-9 blocks T-10, all in Login hardening.",
        "The workspace graph after T-9 is Done.",
        "The workspace graph with T-12 In review.",
        "The workspace graph with T-12 Done and T-13 In progress.",
      ],
      ticket: [
        "T-12 in the app: In progress with one update.",
        "T-12: unchanged.",
        "T-12: In review, a second update, a pull request and a test result.",
        "T-12: Done.",
      ],
      inbox: [
        "The Inbox is empty.",
        "The Inbox is still empty: T-9 isn’t followed.",
        "The Inbox has two entries for T-12, from coding-agent.",
        "The Inbox has four entries; your own Done isn’t one of them.",
      ],
    };

    const BLOCKERS = [
      {
        ref: "T-12",
        title: "Rate-limit failed login attempts",
        base: "In progress",
        to: "T-13",
        toTitle: "Alert on-call when failed logins spike",
        chain: "c1",
      },
      {
        ref: "T-9",
        title: "Add a Redis client for shared counters",
        base: "In review",
        to: "T-10",
        toTitle: "Add a login audit log",
        chain: "c2",
      },
      {
        ref: "T-6",
        title: "Add password reset tokens",
        base: "Todo",
        to: "T-7",
        toTitle: "Send the password reset email",
        chain: "c3",
      },
    ];
    const LOOSE_TODO = ["T-14", "T-11", "T-8", "T-5", "T-4"];

    const FLAGS = [
      {
        id: "documents",
        short: "Docs",
        flag: "--documents",
        key: "documents",
        hl: "documents",
        cap: "Documents: Login abuse notes, linked to T-12.",
        jq: "documents: [.documents.items[] | {heading: .heading.text, fetch}]",
        value: [
          {
            heading: "Login abuse notes",
            fetch: "ticketd document read " + NOTES,
          },
        ],
      },
      {
        id: "activities",
        short: "Updates",
        flag: "--activities",
        key: "updates",
        hl: "activities",
        cap: "Activity: both updates from coding-agent.",
        jq: 'updates: [.activities.items[].brief.text | rtrimstr("\\n")]',
        value: [U2, U1],
      },
      {
        id: "latest",
        short: "Latest",
        flag: "--latest-update",
        key: "latest",
        hl: "latest",
        cap: "The latest update, credited to coding-agent.",
        jq: 'latest: (.latest_update | {brief: (.brief.text | rtrimstr("\\n")), editing_agent})',
        value: { brief: U2, editing_agent: "coding-agent" },
      },
      {
        id: "evidence",
        short: "Proof",
        flag: "--evidence",
        key: "evidence",
        hl: "evidence",
        cap: "Evidence: the branch, pull request #87 and the CI result.",
        jq: "evidence: [.evidence.items[] | {kind, value: .value.text}]",
        value: [
          { kind: "branch", value: "feat/login-rate-limit" },
          {
            kind: "pull_request",
            value: "https://github.com/acme/web-app/pull/87",
          },
          { kind: "verification", value: "passed on CI" },
        ],
      },
      {
        id: "relationships",
        short: "Blocks",
        flag: "--relationships",
        key: "blocking",
        hl: "relationships",
        cap: "Relationships: T-12 blocks T-13.",
        jq: "blocking: [.relationships.blocking.items[].reference]",
        value: ["T-13"],
      },
    ];

    const BAYS = [
      {
        id: "github",
        name: "GitHub in",
        cmd: "source save, source refresh",
        screen: "tickets",
        hl: "gh",
        app: "All tickets",
        say: "Three open issues arrive as T-15, T-16 and T-17. GitHub keeps owning their title and text; closing an issue there closes the ticket here.",
        term: [
          cmd("ticketd source save github --set repositories=acme/web-app"),
          out("{}"),
          cmd("ticketd source refresh"),
          out("{}"),
          cmd(
            "ticketd source status | jq -c '.[0] | {health, tracked_tickets}'",
          ),
          out('{"health":"synced","tracked_tickets":3}'),
        ],
      },
      {
        id: "publish",
        name: "Publish out",
        cmd: "source publish --preview",
        screen: "publish",
        hl: "dialog",
        app: "Publish issue",
        say: "The preview shows exactly what would be sent. Nothing leaves until you press Publish issue.",
        term: [
          cmd("ticketd source publish T-14 --preview \\"),
          cont(
            "    | jq -c '{destination, title, eligibility: .eligibility.kind}'",
          ),
          out(
            '{"destination":"acme/web-app","title":"Show the remaining wait time on the login form","eligibility":"eligible"}',
          ),
        ],
      },
      {
        id: "git",
        name: "Git labels",
        cmd: "evidence add, project list",
        screen: "projects",
        hl: "project",
        app: "Projects",
        say: "Pull requests, commits, branches, worktrees and test results clip onto tickets as evidence. A project is a repository, with its checkouts.",
        term: [
          cmd(
            'ticketd evidence add T-12 --kind pull-request --name "Rate-limit failed logins" \\',
          ),
          cont(
            "    --value https://github.com/acme/web-app/pull/87 --agent coding-agent | jq -r .kind",
          ),
          out("pull_request"),
          cmd("ticketd project list | jq -r '.[].name'"),
          out("web-app"),
        ],
      },
      {
        id: "vault",
        name: "The vault",
        cmd: "backup",
        screen: "backups",
        hl: "backup",
        app: "Settings › Backups",
        say: "Everything lives in one SQLite workspace on your computer. Back it up, restore it, or export it as JSON.",
        term: [
          cmd("ticketd backup ~/backups/ticketd-2026-11-10.sqlite3"),
          out("Backup saved: ~/backups/ticketd-2026-11-10.sqlite3"),
        ],
      },
      {
        id: "drive",
        name: "Google Drive",
        cmd: "coming soon",
        soon: true,
        app: "Google Drive",
        say: "Google Drive attachments are being built: files from Drive on tickets, or uploads kept in a Drive folder.",
        term: [note("# not in a release yet, so there’s no command to run")],
      },
    ];
    const SLIPS = {
      github: [
        ["#41 → T-15", "Passkey sign-in fails on Safari 18"],
        ["#42 → T-16", "Add passkey sign-in"],
        ["#43 → T-17", "Show a clear message when a session expires"],
      ],
      publish: [
        [
          "T-14 → acme/web-app",
          "Show the remaining wait time on the login form",
        ],
        ["preview", "eligible · nothing is sent until you press Publish issue"],
      ],
      git: [
        ["pull request → T-12", "github.com/acme/web-app/pull/87"],
        ["branch → T-12", "feat/login-rate-limit"],
        ["verification → T-12", "passed on CI"],
      ],
      vault: [
        ["backup", "~/backups/ticketd-2026-11-10.sqlite3"],
        ["workspace", "one SQLite file on this computer"],
      ],
      drive: [["coming soon", "not in a release yet"]],
    };
    const GH_VIEWS = [
      { id: "tickets", name: "Tickets", screen: "tickets", hl: "gh" },
      { id: "imported", name: "T-15", screen: "imported", hl: "source" },
      { id: "github", name: "Settings", screen: "github", hl: "card" },
    ];

    // ticketd --help, as the CLI built from main prints it (the first commands of the list).
    const HELP = [
      "Local ticket workspace",
      "",
      "Usage: ticketd.exe <COMMAND>",
      "",
      "Commands:",
      "  document             Capture and read Documents",
      "  reminder             Manage a personal ticket reminder (times require an RFC 3339 offset)",
      "  inbox                List personal inbox entries (newest first)",
      "  backup               Save a consistent workspace backup to a new file",
      "  restore-workspace    Restore a workspace backup after closing other ticketd operations",
      "  export               Export a portable JSON snapshot to stdout or a new file",
      '  write                Execute a JSON write request (file or - for stdin); prints {"kind","value"}. With --request-id, a retry returns the first result. Other commands print the bare object; `activity add/edit` and `document create/change` also accept --request-id with the same replay behavior',
      "  batch                Apply a JSON array of operations from a file or - for stdin",
      "  project              Manage repository projects",
      "  …",
    ];
    this._data = {
      HELP,
      cmd,
      cont,
      out,
      note,
      LINE,
      CHANNELS,
      SHIFT,
      INBOX,
      INBOX_NOTE,
      MON_SR,
      BLOCKERS,
      LOOSE_TODO,
      FLAGS,
      BAYS,
      GH_VIEWS,
      SLIPS,
    };
    return this._data;
  }

  // Hero: the factory makes a ticket, then reads one.
  runHero(kind) {
    clearTimeout(this.heroAutoTimer);
    this.heroTimers.forEach((id) => clearTimeout(id));
    this.heroTimers = [];
    const later = (ms, fn) => this.heroTimers.push(setTimeout(fn, ms));
    const make = kind === "make";
    if (this.reduced()) {
      this.setState(
        make
          ? {
              focus: "top",
              heroMade: true,
              heroLast: "make",
              heroPhase: "make-done",
            }
          : {
              focus: "top",
              heroRead: true,
              heroLast: "read",
              heroPhase: "read-done",
            },
      );
      return;
    }
    this.setState({
      focus: "top",
      heroRun: "idle",
      heroLast: kind,
      heroPhase: kind,
      heroK: this.state.heroK === "a" ? "b" : "a",
    });
    later(40, () => this.setState({ heroRun: kind }));
    const end = make ? 3400 : 3900;
    later(end - 500, () =>
      this.setState(
        make
          ? {
              heroMade: true,
              heroPhase: "make-done",
              heroK: this.state.heroK === "a" ? "b" : "a",
            }
          : {
              heroRead: true,
              heroPhase: "read-done",
              heroK: this.state.heroK === "a" ? "b" : "a",
            },
      ),
    );
    later(end, () => this.setState({ heroRun: "idle" }));
  }

  heroDemo() {
    this.runHero("make");
    this.heroTimers.push(setTimeout(() => this.runHero("read"), 4200));
  }

  // 01 The line: a station runs one machine; Run the line runs every station.
  pickStep(i, chained) {
    if (!chained) {
      this.lineTimers.forEach((id) => clearTimeout(id));
      this.lineTimers = [];
    }
    const step = this.data().LINE[i];
    const total = (this.state.lineWho === "you" ? step.you : step.term).length;
    if (this.reduced()) {
      this.setState({
        focus: "line",
        lineStep: i,
        lineDone: Math.max(this.state.lineDone, i),
        linePhase: "idle",
        linePrinted: total,
        lineAuto: !!chained,
        pulse: this.pulseOf("line"),
      });
      return;
    }
    this.setState({
      focus: "line",
      lineStep: i,
      linePhase: "run",
      linePrinted: 0,
      lineAuto: !!chained,
    });
    let n = 0;
    const tick = () => {
      n += 1;
      this.setState({ linePrinted: n });
      if (n < total) this.lineTimers.push(setTimeout(tick, 240));
      else
        this.lineTimers.push(
          setTimeout(
            () =>
              this.setState({
                linePhase: "idle",
                lineDone: Math.max(this.state.lineDone, i),
                pulse: this.pulseOf("line"),
              }),
            600,
          ),
        );
    };
    this.lineTimers.push(setTimeout(tick, 900));
  }

  runLine() {
    this.lineTimers.forEach((id) => clearTimeout(id));
    this.lineTimers = [];
    if (this.reduced()) {
      this.pickStep(this.data().LINE.length - 1);
      return;
    }
    this.setState({ lineDone: -1 });
    const gap = this.reduced() ? 0 : 3600;
    const steps = this.data().LINE.length;
    for (let i = 0; i < steps; i += 1)
      this.lineTimers.push(setTimeout(() => this.pickStep(i, true), i * gap));
    this.lineTimers.push(
      setTimeout(() => this.setState({ lineAuto: false }), steps * gap),
    );
  }

  // 02 The monitor: four recorded moments of one shift.
  setK(k, keepPlaying) {
    const next = {
      focus: "mon",
      monK: k,
      monFlick: this.state.monFlick === "a" ? "b" : "a",
      monLive: true,
    };
    if (!keepPlaying) {
      clearInterval(this.monTimer);
      this.monTimer = null;
      next.monPlaying = false;
    }
    this.setState(next);
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.setState({ monLive: false }), 1900);
  }

  playShift(fromStart) {
    clearInterval(this.monTimer);
    if (this.reduced()) {
      this.setK(3);
      return;
    }
    const start = fromStart || this.state.monK >= 3 ? 0 : this.state.monK;
    this.setState({ monPlaying: true });
    this.setK(start, true);
    let k = start;
    this.monTimer = setInterval(() => {
      k += 1;
      this.setK(k, true);
      if (k >= 3) {
        clearInterval(this.monTimer);
        this.monTimer = null;
        this.setState({ monPlaying: false });
      }
    }, 3000);
  }

  // 03 Dispatch: Ready is a Todo ticket with no unresolved blocker; only Done resolves one.
  bay() {
    return {
      done: this.state.done || { "T-12": false, "T-9": false, "T-6": false },
      plug: this.state.plug || { c1: true, c2: true, c3: true },
    };
  }

  model(done, plug) {
    const { BLOCKERS, LOOSE_TODO } = this.data();
    const status = (ref) => {
      const b = BLOCKERS.find((x) => x.ref === ref);
      if (b) return done[ref] ? "Done" : b.base;
      return "Todo";
    };
    const blockers = (ref) =>
      BLOCKERS.filter(
        (b) => b.to === ref && plug[b.chain] && status(b.ref) !== "Done",
      ).map((b) => b.ref);
    const avail = (ref) =>
      status(ref) === "Todo"
        ? blockers(ref).length
          ? "Blocked"
          : "Ready"
        : "none";
    const todo = LOOSE_TODO.concat(BLOCKERS.map((b) => b.to)).concat(
      BLOCKERS.filter((b) => b.base === "Todo").map((b) => b.ref),
    );
    const ready = todo
      .filter((ref) => avail(ref) === "Ready")
      .sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)));
    return { status, blockers, avail, ready };
  }

  dispChange(next, act) {
    const before = this.bay();
    const after = {
      done: Object.assign({}, before.done, next.done || {}),
      plug: Object.assign({}, before.plug, next.plug || {}),
    };
    const was = this.model(before.done, before.plug).ready;
    const now = this.model(after.done, after.plug).ready;
    const joined = now.filter((r) => was.indexOf(r) === -1);
    const left = was.filter((r) => now.indexOf(r) === -1);
    let log;
    if (joined.length)
      log =
        joined.join(", ") +
        (joined.length > 1 ? " are" : " is") +
        " Ready now, so " +
        (joined.length > 1 ? "they’re" : "it’s") +
        " on your agent’s list.";
    else if (left.length) log = left.join(", ") + " left the list.";
    else log = "Nothing waiting on that changes.";
    this.setState({
      focus: "disp",
      done: after.done,
      plug: after.plug,
      picked: null,
      dispLog: log,
      dispMood: joined.length ? "cheer" : "surprised",
      dispFresh: joined,
      pulse: this.pulseOf("disp"),
      dispEcho: act
        ? (this.state.dispEcho || [])
            .concat([this.echoFor(act, after)])
            .slice(-2)
        : this.state.dispEcho || [],
    });
  }

  askForWork() {
    const b = this.bay();
    const first = this.model(b.done, b.plug).ready[0] || null;
    this.setState({
      focus: "disp",
      picked: first,
      dispMood: first ? "cheer" : "surprised",
      pulse: this.pulseOf("disp"),
    });
  }

  // What the CLI prints for a dispatch control, from the model after the change (recorded: change,
  // add-dependency and remove-dependency print the changed ticket; jq picks one field).
  echoFor(act, after) {
    const { cmd, out, BLOCKERS } = this.data();
    const b = BLOCKERS[act.i];
    const m = this.model(after.done, after.plug);
    if (act.kind === "done") {
      const st = m.status(b.ref);
      return [
        cmd(
          "ticketd change " +
            b.ref +
            " --status " +
            (st.indexOf(" ") >= 0 ? '"' + st + '"' : st) +
            " | jq -r .status",
        ),
        out(st),
      ];
    }
    const on = after.plug[b.chain];
    return [
      cmd(
        "ticketd " +
          (on ? "add-dependency " : "remove-dependency ") +
          b.ref +
          " " +
          b.to +
          " | jq -r .availability",
      ),
      out(m.avail(b.to) === "none" ? m.status(b.to) : m.avail(b.to)),
    ];
  }

  toggleDone(i) {
    const b = this.data().BLOCKERS[i];
    this.dispChange(
      { done: { [b.ref]: !this.bay().done[b.ref] } },
      { kind: "done", i },
    );
  }

  togglePlug(i) {
    const b = this.data().BLOCKERS[i];
    this.dispChange(
      { plug: { [b.chain]: !this.bay().plug[b.chain] } },
      { kind: "plug", i },
    );
  }

  // A chain is dragged: dropped on its waiting ticket it hooks on, pulled well away it comes off, a
  // click toggles it like the button beside it.
  dragFor(i) {
    if (!this.drags) this.drags = {};
    if (this.drags[i]) return this.drags[i];
    const at = (event, row) => {
      const R = row.getBoundingClientRect();
      const k = R.width / Math.max(1, row.offsetWidth);
      return [
        Math.round((event.clientX - R.left) / k),
        Math.round((event.clientY - R.top) / k),
      ];
    };
    this.drags[i] = {
      down: (event) => {
        const row = event.currentTarget.closest(".dp2-row");
        if (!row) return;
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* capture is optional */
        }
        this.dragRow = row;
        const p = at(event, row);
        this.setState({
          drag: { i, x0: p[0], y0: p[1], x: p[0], y: p[1], over: false },
        });
      },
      move: (event) => {
        const d = this.state.drag;
        if (!d || d.i !== i || !this.dragRow) return;
        const p = at(event, this.dragRow);
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const over = !!(
          el &&
          el.closest('[data-end="to"]') &&
          el.closest(".dp2-row") === this.dragRow
        );
        this.setState({
          drag: Object.assign({}, d, { x: p[0], y: p[1], over }),
        });
      },
      up: () => {
        const d = this.state.drag;
        if (!d || d.i !== i) return;
        const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
        const loose = !this.bay().plug[this.data().BLOCKERS[i].chain];
        this.dragRow = null;
        this.setState({ drag: null });
        if (moved < 6 || (loose && d.over) || (!loose && moved > 40))
          this.togglePlug(i);
      },
      cancel: () => {
        this.dragRow = null;
        this.setState({ drag: null });
      },
    };
    return this.drags[i];
  }

  // Pointing at a part replays its mechanism; the a/b suffix restarts the animation on each visit.
  setHot(group, val) {
    const cur = this.state.hot || {};
    let next = "";
    if (val) {
      if ((cur[group] || "").split("-")[0] === val) return;
      this.flips[group] = this.flips[group] === "a" ? "b" : "a";
      next = val + "-" + this.flips[group];
    } else if (!cur[group]) return;
    this.setState({ hot: Object.assign({}, cur, { [group]: next }) });
  }

  // A knob with detents over 240 degrees: dragged, it follows the pointer round its axle and snaps;
  // the arrow keys, Home and End step it.
  knob(kind) {
    if (!this.knobs) this.knobs = {};
    if (this.knobs[kind]) return this.knobs[kind];
    const D = this.data();
    const n = kind === "ch" ? D.CHANNELS.length : 4;
    const step = 240 / (n - 1);
    const now = () =>
      kind === "ch"
        ? Math.max(
            0,
            D.CHANNELS.findIndex((c) => c.id === this.state.monCh),
          )
        : this.state.monK || 0;
    const pick = (i) => {
      const k = Math.max(0, Math.min(n - 1, i));
      if (k === now()) return;
      if (kind === "ch")
        this.setState({
          focus: "mon",
          monCh: D.CHANNELS[k].id,
          monFlick: this.state.monFlick === "a" ? "b" : "a",
        });
      else this.setK(k);
    };
    const fromPointer = (event) => {
      const r = event.currentTarget.getBoundingClientRect();
      const a =
        (Math.atan2(
          event.clientX - (r.left + r.width / 2),
          r.top + r.height / 2 - event.clientY,
        ) *
          180) /
        Math.PI;
      return Math.round((Math.max(-120, Math.min(120, a)) + 120) / step);
    };
    this.knobs[kind] = {
      down: (event) => {
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* capture is optional */
        }
        this.knobDrag = kind;
        pick(fromPointer(event));
      },
      move: (event) => {
        if (this.knobDrag === kind) pick(fromPointer(event));
      },
      up: () => {
        this.knobDrag = null;
      },
      key: (event) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[
          event.key
        ];
        if (d === undefined && event.key !== "Home" && event.key !== "End")
          return;
        event.preventDefault();
        pick(
          event.key === "Home" ? 0 : event.key === "End" ? n - 1 : now() + d,
        );
      },
    };
    return this.knobs[kind];
  }

  // The status bar follows the sheet crossing the middle of the viewport, when the page scrolls.
  setupSpy(root) {
    if (this.spy || typeof IntersectionObserver === "undefined") return;
    this.spy = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting)
            this.setState({ inView: entry.target.getAttribute("data-sheet") });
        }),
      { rootMargin: "-50% 0px -50% 0px" },
    );
    root.querySelectorAll("[data-sheet]").forEach((el) => this.spy.observe(el));
  }

  // Each $ line gets a copy button that copies the whole command with its continuation lines.
  copyable(lines, key) {
    return lines.map((ln, i) => {
      if (ln.prompt !== "$ ") return Object.assign({}, ln, { copy: false });
      let full = ln.text;
      for (let j = i + 1; j < lines.length && lines[j].prompt === "  "; j += 1)
        full += "\n" + lines[j].text;
      const id = key + ":" + i;
      return Object.assign({}, ln, {
        copy: true,
        copyText:
          this.state.copyFailed === id
            ? "copy failed"
            : this.state.copied === id
              ? "copied"
              : "copy",
        copyIt: () => this.copy(full, id),
      });
    });
  }

  copy(text, id) {
    const done = () => {
      this.setState({ copied: id, copyFailed: null });
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.setState({ copied: "" }), 1400);
    };
    const failed = () => this.setState({ copied: "", copyFailed: id });
    const fallback = () => {
      const t = document.createElement("textarea");
      try {
        t.value = text;
        t.setAttribute("readonly", "");
        t.style.position = "fixed";
        t.style.opacity = "0";
        document.body.appendChild(t);
        t.select();
        if (document.execCommand("copy")) done();
        else failed();
      } catch {
        failed();
      } finally {
        t.remove();
      }
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch {
      fallback();
    }
  }

  // 07 Start: type the command, print the help, then pull the camera back to the monitor.
  runStart() {
    this.startTimers.forEach((id) => clearTimeout(id));
    this.startTimers = [];
    const CMD = "ticketd --help";
    const n = this.data().HELP.length;
    if (this.reduced()) {
      this.setState({
        startPhase: "done",
        startTyped: CMD.length,
        startLines: n,
      });
      return;
    }
    const at = (ms, fn) => this.startTimers.push(setTimeout(fn, ms));
    this.setState({ startPhase: "type", startTyped: 0, startLines: 0 });
    for (let i = 1; i <= CMD.length; i += 1)
      at(400 + i * 75, () => this.setState({ startTyped: i }));
    const printed = 400 + CMD.length * 75 + 300;
    at(printed, () => this.setState({ startPhase: "print" }));
    for (let j = 1; j <= n; j += 1)
      at(printed + j * 70, () => this.setState({ startLines: j }));
    const pull = printed + n * 70 + 700;
    at(pull, () => this.setState({ startPhase: "pull" }));
    at(pull + 1900, () => this.setState({ startPhase: "done" }));
  }

  // 04 Assembly
  scopes() {
    return (
      this.state.scopes || {
        documents: true,
        activities: false,
        latest: true,
        evidence: true,
        relationships: false,
      }
    );
  }

  toggleScope(id) {
    const cur = this.scopes();
    this.setState({
      focus: "asm",
      scopes: Object.assign({}, cur, { [id]: !cur[id] }),
      lastScope: cur[id] ? null : id,
      shipped: false,
      pulse: this.pulseOf("asm"),
    });
  }

  shipIt() {
    this.setState({
      focus: "asm",
      ship: this.state.ship === "a" ? "b" : "a",
      shipped: true,
      pulse: this.pulseOf("asm"),
    });
    clearTimeout(this.shipTimer);
    this.shipTimer = setTimeout(() => this.setState({ ship: "none" }), 1300);
  }

  // 05 Dock
  openBay(id) {
    const opened = Object.assign({}, this.state.opened || {}, { [id]: true });
    this.setState({
      focus: "dock",
      bay: id,
      opened,
      ghView: id === "github" ? "tickets" : this.state.ghView,
      pulse: this.pulseOf("dock"),
    });
  }

  renderVals() {
    const props = this.props || {};
    const s = this.state || {};
    const D = this.data();
    const { cmd, out, note } = D;

    let systemDark;
    try {
      systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      systemDark = false;
    }
    const preference = props.theme || "system";
    const theme =
      s.theme ||
      (preference === "system" ? (systemDark ? "dark" : "light") : preference);
    const isDark = theme === "dark";

    // Hero: the cat narrates what the factory runs, in the terminal's words.
    const SAY = {
      idle: "MEOW!",
      make: "$ ticketd document create-ticket …",
      "make-done": "→ T-12 · Ready in your app",
      read: "$ ticketd context T-12 --documents",
      "read-done": "→ In progress · Login abuse notes",
    };
    const STATUS = {
      idle: "context in · tickets out · tickets in · context out",
      make: "pressing a ticket from the spec…",
      "make-done": "made T-12 · it’s Ready in the app",
      read: "reading T-12 for the next session…",
      "read-done": "context out: status, notes, latest update",
    };
    const phase = s.heroPhase || "idle";
    const hero = {
      run: s.heroRun || "idle",
      made: !!s.heroMade,
      read: !!s.heroRead,
      k: s.heroK || "a",
      say: SAY[phase] || SAY.idle,
      status: STATUS[phase] || STATUS.idle,
      isMake: s.heroLast === "make",
      isRead: s.heroLast === "read",
      make: () => this.runHero("make"),
      readFn: () => this.runHero("read"),
      hot: (s.hot || {}).hero || "",
      hotCore: () => this.setHot("hero", "core"),
      hotPress: () => this.setHot("hero", "press"),
      hotReader: () => this.setHot("hero", "reader"),
      cold: () => this.setHot("hero", ""),
      ready: s.heroMade
        ? ["T-12", "T-11", "T-8", "T-6", "T-5", "T-4"]
        : ["T-11", "T-8", "T-6", "T-5", "T-4"],
      fresh: s.heroMade ? ["T-12"] : [],
      crop: [224, 40, 384, 232],
      sr: s.heroMade
        ? "The app’s Ready list now starts with T-12, Rate-limit failed login attempts."
        : "The app’s Ready list: T-11, T-8, T-6, T-5 and T-4.",
    };

    // 01 The line
    const idx = s.lineStep;
    const cur = D.LINE[Math.max(0, idx)];
    const you = s.lineWho === "you";
    const term =
      idx < 0
        ? [note("# pick a machine, or run the line")]
        : you
          ? cur.you
          : cur.term;
    const printed =
      idx < 0
        ? term.length
        : s.linePhase === "run"
          ? s.linePrinted
          : term.length;
    const done = (i) => i <= s.lineDone || (i === idx && s.linePhase !== "run");
    const line = {
      step: String(idx),
      running: s.linePhase === "run" && !you,
      d0: done(0),
      d1: done(1),
      d2: done(2),
      d3: done(3),
      d4: done(4),
      rx: String(Math.max(0, idx) * 206),
      stations: D.LINE.map((m, i) => ({
        num: m.num,
        name: m.name,
        cmd: m.cmdHint,
        on: i === idx,
        done: done(i),
        left: (((66 + i * 206 + 31) / 1114) * 100).toFixed(2) + "%",
        label: m.num + " " + m.name + ": " + m.cmdHint,
        pick: () => this.pickStep(i),
        hot: () => this.setHot("line", String(i)),
        tip: "ticketd " + m.cmdHint.replace(/, /g, " · "),
      })),
      hot: (s.hot || {}).line || "",
      cold: () => this.setHot("line", ""),
      runAll: () => this.runLine(),
      runLabel: s.lineAuto ? "Running the line…" : "Run the line",
      isAgent: !you,
      isYou: you,
      setAgent: () => this.setState({ lineWho: "agent" }),
      setYou: () => this.setState({ lineWho: "you" }),
      title:
        idx < 0 ? "Five machines, one ticket." : cur.num + " " + cur.name + ".",
      say:
        idx < 0
          ? "Watch T-12 go from spec to progress update."
          : you
            ? "You can run any machine yourself, in the app."
            : cur.say,
      termTitle: you
        ? "you · ticketd desktop app"
        : "your agent · ~/code/web-app",
      lines: this.copyable(
        term
          .slice(0, printed)
          .map((ln) => Object.assign({}, ln, { isNew: s.linePhase === "run" })),
        "line",
      ),
      cursor: s.linePhase === "run",
      screen: idx < 0 ? "spec" : cur.screen,
      hl: idx < 0 || (s.linePhase === "run" && s.linePrinted < 2) ? "" : cur.hl,
      appTitle: idx < 0 ? "Documents" : cur.app,
      capLabel: idx < 0 ? "In the app" : "Changed",
      cap:
        idx < 0
          ? "Each machine’s result shows up here, in the real app."
          : cur.cap,
    };

    // 02 The monitor
    const k = Math.max(0, Math.min(3, s.monK || 0));
    const ch = D.CHANNELS.find((c) => c.id === s.monCh) || D.CHANNELS[1];
    const lastEvent = D.SHIFT.filter((e) => e.k <= k).slice(-1)[0];
    const mon = {
      k: String(k),
      screen: ch.id + k,
      n: ch.n,
      chName: ch.name,
      sr: D.MON_SR[ch.id][k],
      chDeg: -120 + D.CHANNELS.indexOf(ch) * 60 + "deg",
      tDeg: -120 + k * 80 + "deg",
      tText: D.SHIFT.filter((e) => e.k === k)[0].t,
      kch: this.knob("ch"),
      kt: this.knob("t"),
      go: (id) => {
        if (D.CHANNELS.some((c) => c.id === id))
          this.setState({
            focus: "mon",
            monCh: id,
            monFlick: this.state.monFlick === "a" ? "b" : "a",
          });
      },
      flick: s.monFlick || "a",
      live: !!s.monLive,
      inbox: String(D.INBOX[k]),
      inboxNote: D.INBOX_NOTE[k],
      inboxLabel: "Inbox: " + D.INBOX[k] + " unread, " + D.INBOX_NOTE[k],
      channels: D.CHANNELS.map((c) => ({
        n: c.n,
        name: c.name,
        hint: c.hint,
        on: c.id === ch.id,
        pick: () =>
          this.setState({
            focus: "mon",
            monCh: c.id,
            monFlick: this.state.monFlick === "a" ? "b" : "a",
          }),
      })),
      events: D.SHIFT.map((e) => ({
        t: e.t,
        who: e.who,
        text: e.text,
        bell: !!e.bell,
        state: e.k < k ? "past" : e.k === k ? "now" : "future",
        go: () => this.setK(e.k),
      })),
      status: lastEvent.t + " · " + lastEvent.status,
      playing: !!s.monPlaying,
      paused: !s.monPlaying,
      playText: s.monPlaying
        ? "Pause"
        : k >= 3
          ? "Replay the shift"
          : "Play the shift",
      toggle: () => {
        if (!this.state.monPlaying) {
          this.playShift(false);
          return;
        }
        clearInterval(this.monTimer);
        this.monTimer = null;
        this.setState({ monPlaying: false });
      },
      rewind: () => this.setK(0),
      next: () => this.setK(Math.min(3, (this.state.monK || 0) + 1)),
      seek: (event) =>
        this.setK(Number(event && event.target ? event.target.value : 0)),
    };

    // 03 Dispatch
    const bs = this.bay();
    const model = this.model(bs.done, bs.plug);
    const tone = (ref) => {
      const av = model.avail(ref);
      if (av === "Ready") return "ready";
      if (av === "Blocked") return "blocked";
      return (
        { "In progress": "progress", "In review": "review", Done: "done" }[
          model.status(ref)
        ] || "todo"
      );
    };
    const label = (ref) => {
      const av = model.avail(ref);
      if (av === "Ready") return "Todo · Ready";
      if (av === "Blocked")
        return "Todo · Blocked by " + model.blockers(ref).join(", ");
      return model.status(ref);
    };
    const picked = s.picked;
    const dispLines = [].concat(
      ...(s.dispEcho || []),
      [cmd("ticketd list --availability ready | jq -r '.[].reference'")],
      model.ready.map((r) => out(r)),
    );
    if (picked)
      dispLines.push(
        cmd(
          "ticketd list --availability ready --limit 1 | jq -r '.[0].reference'",
        ),
        out(picked),
      );
    const disp = {
      rows: D.BLOCKERS.map((b, bi) => {
        const dg = s.drag && s.drag.i === bi ? s.drag : null;
        const loose = !bs.plug[b.chain];
        return {
          from: b.ref,
          fromTitle: b.title,
          fromState: label(b.ref),
          bAvail: model.avail(b.ref),
          bTone: tone(b.ref),
          to: b.to,
          toTitle: b.toTitle,
          toState: label(b.to),
          tAvail: model.avail(b.to),
          tTone: tone(b.to),
          done: !!bs.done[b.ref],
          doneLabel: b.ref + " Done",
          toggleDone: () => this.toggleDone(bi),
          chain: loose
            ? "loose"
            : model.status(b.ref) === "Done"
              ? "resolved"
              : "live",
          hookText: loose ? "Chain" : "Unhook",
          hookLabel: loose
            ? "Chain " + b.to + " to " + b.ref
            : "Unhook " + b.to + " from " + b.ref,
          toggleHook: () => this.togglePlug(bi),
          drag: this.dragFor(bi),
          dragging: !!dg,
          dropOn: !!(dg && dg.over),
          band: dg ? "M" + dg.x0 + " " + dg.y0 + "L" + dg.x + " " + dg.y : "",
        };
      }),
      tray: model.ready.map((r) => ({ ref: r, picked: r === picked })),
      crop: [224, 28, 384, 400],
      ready: model.ready,
      fresh: s.dispFresh || [],
      pose: picked ? "cheer" : s.dispMood || "idle",
      say: picked
        ? "Your agent gets " + picked + ", the first Ready ticket."
        : s.dispLog ||
          "T-13, T-10 and T-7 wait on unfinished work, so your agent won’t get them yet.",
      ask: () => this.askForWork(),
      lines: this.copyable(dispLines, "disp"),
      cap: model.ready.length
        ? model.ready.join(", ") +
          ". Todo tickets with no unresolved blocking dependency."
        : "Nothing is Ready.",
    };

    // 04 Assembly
    const scopes = this.scopes();
    const sel = D.FLAGS.filter((f) => scopes[f.id]);
    const asmLines = [];
    if (!sel.length) {
      asmLines.push(
        cmd("ticketd context T-12 | jq '{status: .ticket.status}'"),
      );
    } else {
      asmLines.push(
        cmd("ticketd context T-12 " + sel.map((f) => f.flag).join(" ") + " \\"),
      );
      asmLines.push(D.cont("    | jq '{status: .ticket.status,"));
      sel.forEach((f, i) =>
        asmLines.push(
          D.cont("          " + f.jq + (i === sel.length - 1 ? "}'" : ",")),
        ),
      );
    }
    const entries = [["status", "In review"]].concat(
      sel.map((f) => [f.key, f.value]),
    );
    asmLines.push(out("{"));
    entries.forEach((entry, i) => {
      const body = JSON.stringify(entry[1], null, 2).split("\n");
      body.forEach((ln, j) =>
        asmLines.push(
          out(
            (j === 0 ? '  "' + entry[0] + '": ' : "  ") +
              ln +
              (j === body.length - 1 && i < entries.length - 1 ? "," : ""),
          ),
        ),
      );
    });
    asmLines.push(out("}"));
    if (s.shipped)
      asmLines.push(
        note("# shipped: your agent’s next session starts from this"),
      );
    const lastFlag =
      D.FLAGS.find((f) => f.id === s.lastScope && scopes[f.id]) ||
      sel[sel.length - 1];
    // jq emits UTF-8 and terminates its JSON with a newline.
    const bytes = new TextEncoder().encode(
      JSON.stringify(Object.fromEntries(entries), null, 2) + "\n",
    ).byteLength;
    const asm = {
      bytes: String(bytes),
      needle: (-120 + 240 * Math.min(1, bytes / 1000)).toFixed(1) + "deg",
      p0: !!scopes.documents,
      p1: !!scopes.activities,
      p2: !!scopes.latest,
      p3: !!scopes.evidence,
      p4: !!scopes.relationships,
      ship: s.ship || "none",
      shipIt: () => this.shipIt(),
      count: String(sel.length),
      say: sel.length
        ? "That’s exactly what your agent reads, and nothing more."
        : "Your agent gets the status and nothing else.",
      flags: D.FLAGS.map((f, fi) => ({
        short: f.short,
        flag: f.flag,
        on: !!scopes[f.id],
        toggle: () => this.toggleScope(f.id),
        hot: () => this.setHot("asm", String(fi)),
        left: (((150 + fi * 116 - 6) / 960) * 100).toFixed(2) + "%",
        label: "Hopper: " + f.short + ", " + f.flag,
        tip: "ticketd context T-12 " + f.flag,
      })),
      hot: (s.hot || {}).asm || "",
      cold: () => this.setHot("asm", ""),
      lines: this.copyable(asmLines, "asm"),
      hl: lastFlag ? lastFlag.hl : "",
      cap: lastFlag ? lastFlag.cap : "T-12, as you see it in the app.",
    };

    // 05 Dock
    const bayNow = D.BAYS.find((b) => b.id === s.bay) || D.BAYS[0];
    const ghView = D.GH_VIEWS.find((v) => v.id === s.ghView) || D.GH_VIEWS[0];
    const opened = s.opened || {};
    const gh = bayNow.id === "github";
    const dock = {
      bays: D.BAYS.map((b, i) => ({
        n: "0" + (i + 1),
        name: b.name,
        cmd: b.cmd,
        soon: !!b.soon,
        on: b.id === bayNow.id,
        left: (((52 + i * 248) / 1320) * 100).toFixed(2) + "%",
        label: "Open bay " + (i + 1) + ", " + b.name,
        pick: () => this.openBay(b.id),
        hot: () => this.setHot("dock", String(i)),
        tip: b.soon
          ? "Google Drive · coming soon"
          : "ticketd " + b.cmd.replace(/, /g, " · "),
      })),
      peek: (s.hot || {}).dock || "",
      cold: () => this.setHot("dock", ""),
      go: (id) => {
        if (D.GH_VIEWS.some((v) => v.id === id))
          this.setState({
            focus: "dock",
            bay: "github",
            ghView: id,
            opened: Object.assign({}, this.state.opened || {}, {
              github: true,
            }),
            pulse: this.pulseOf("dock"),
          });
      },
      slipHead:
        "bay " +
        "0" +
        (D.BAYS.indexOf(bayNow) + 1) +
        " · " +
        (opened[bayNow.id] ? bayNow.name.toLowerCase() : "shut"),
      slip: opened[bayNow.id]
        ? D.SLIPS[bayNow.id].map((r) => ({ k: r[0], v: r[1] }))
        : [{ k: "shut", v: "pick a bay to open it" }],
      o0: !!opened.github,
      o1: !!opened.publish,
      o2: !!opened.git,
      o3: !!opened.vault,
      o4: !!opened.drive,
      name: bayNow.name,
      lines: this.copyable(
        opened[bayNow.id] ? bayNow.term : [note("# pick a bay")],
        "dock",
      ),
      say: bayNow.say,
      capLabel: bayNow.soon ? "Soon" : "In the app",
      appTitle: gh
        ? ghView.id === "imported"
          ? "T-15, owned by GitHub"
          : ghView.id === "github"
            ? "Settings › GitHub"
            : "All tickets"
        : bayNow.app,
      isSoon: !!bayNow.soon,
      hasApp: !bayNow.soon,
      hasViews: gh,
      views: D.GH_VIEWS.map((v) => ({
        name: v.name,
        on: v.id === ghView.id,
        pick: () =>
          this.setState({
            focus: "dock",
            ghView: v.id,
            pulse: this.pulseOf("dock"),
          }),
      })),
      screen: gh ? ghView.screen : bayNow.screen || "tickets",
      hl: opened[bayNow.id] ? (gh ? ghView.hl : bayNow.hl) : "",
    };

    const focus = s.focus || "top";
    const STATUS_BY = {
      top: s.heroLast ? "factory · " + (STATUS[phase] || "") : "ready",
      line:
        idx >= 0
          ? "line · " +
            cur.num +
            " " +
            cur.name.toLowerCase() +
            " · ticketd " +
            cur.cmdHint
          : "ready",
      mon:
        "monitor · ch" +
        ch.n +
        " " +
        ch.name.toLowerCase() +
        " · " +
        lastEvent.t +
        " · " +
        lastEvent.status,
      disp:
        "dispatch · ready: " +
        (model.ready.join(" ") || "none") +
        (picked ? " · agent took " + picked : ""),
      asm:
        "assembly · ticketd context T-12 " + sel.map((f) => f.flag).join(" "),
      dock:
        "dock · " +
        bayNow.name.toLowerCase() +
        " · " +
        (bayNow.soon ? "coming soon" : "ticketd " + bayNow.cmd),
      faq: "help · 6 answers",
      start:
        "start · " +
        ({
          type: "typing ticketd --help",
          print: "printing help",
          pull: "pulling back",
        }[s.startPhase] || "awaiting input"),
    };
    let scrolling;
    try {
      scrolling =
        document.documentElement.scrollHeight > window.innerHeight + 40;
    } catch {
      scrolling = false;
    }
    const sheet = (scrolling && s.inView) || focus;

    const blockedNow = D.BLOCKERS.filter(
      (b) => model.avail(b.to) === "Blocked",
    ).length;
    const shipping = s.ship === "a" || s.ship === "b";
    const bayOpen = !!opened[bayNow.id];
    const plate = {
      line: {
        on: s.linePhase === "run",
        text:
          s.linePhase === "run"
            ? "running · " + cur.num + " " + cur.name.toLowerCase()
            : s.lineDone >= D.LINE.length - 1
              ? "line done · T-12 in progress"
              : idx >= 0
                ? "idle · " + cur.num + " " + cur.name.toLowerCase()
                : D.LINE.length + " machines · idle",
      },
      mon: {
        on: !!s.monPlaying || !!s.monLive,
        text:
          (s.monPlaying ? "live · " : "replay · ") +
          lastEvent.t +
          " · ch" +
          ch.n +
          " " +
          ch.name.toLowerCase(),
      },
      disp: {
        on: !!picked || !!(s.dispFresh && s.dispFresh.length),
        text: model.ready.length + " ready · " + blockedNow + " blocked",
      },
      asm: {
        on: shipping,
        text: sel.length + " of 5 parts" + (shipping ? " · shipping" : ""),
      },
      dock: {
        on: bayOpen,
        text: bayOpen
          ? "bay " +
            dock.bays.find((b) => b.on).n +
            " open · " +
            bayNow.name.toLowerCase()
          : "all bays shut",
      },
      faq: { on: false, text: "6 answers" },
      start: {
        on: true,
        text:
          {
            type: "typing ticketd --help",
            print: "printing help",
            pull: "pulling back",
          }[s.startPhase] || "awaiting input",
      },
    };

    return {
      yes: true,
      setRoot: this.setRoot,
      cables: Object.assign(
        { line: "", disp: "", asm: "", dock: "" },
        s.cables || {},
      ),
      pulse: Object.assign(
        { line: "none", disp: "none", asm: "none", dock: "none" },
        s.pulse || {},
      ),
      plate,
      theme,
      isDark,
      isLight: !isDark,
      setLight: () => this.setState({ theme: "light" }),
      setDark: () => this.setState({ theme: "dark" }),
      motion: props.motion || "system",
      views: {
        line: this.view("line"),
        monitor: this.view("monitor"),
        dock: this.view("dock"),
        start: this.view("start"),
        foot: this.view("foot"),
      },
      start: {
        phase: s.startPhase || "idle",
        typed: "ticketd --help".slice(0, s.startTyped),
        out: D.HELP.slice(0, s.startLines).join("\n"),
        cursor: s.startPhase === "type" || s.startPhase === "print",
        replay: () => this.runStart(),
      },
      foot: { punch: !!s.footPunch },
      hero,
      line,
      mon,
      disp,
      asm,
      dock,
      statusLine: STATUS_BY[sheet] || "ready",
      nav: {
        top: sheet === "top",
        line: sheet === "line",
        mon: sheet === "mon",
        disp: sheet === "disp",
        asm: sheet === "asm",
        dock: sheet === "dock",
        faq: sheet === "faq",
        start: sheet === "start",
      },
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <>
        <div
          className={"st"}
          id={"top"}
          data-theme={v.theme}
          data-motion={v.motion}
          ref={v.setRoot}
        >
          <svg
            className={"x-defs"}
            width={"0"}
            height={"0"}
            aria-hidden={"true"}
            style={{ position: "absolute" }}
            dangerouslySetInnerHTML={{ __html: markup[0] }}
          />
          <header className={"st-nav"}>
            <div className={"st-nav-in"}>
              <a className={"st-brand"} href={"#top"}>
                <span>{"ticketd"}</span>
              </a>
              <nav className={"st-navlinks"} aria-label={"Page sections"}>
                <a href={"#line"}>{"The line"}</a>
                <a href={"#monitor"}>{"Monitor"}</a>
                <a href={"#dispatch"}>{"Dispatch"}</a>
                <a href={"#dock"}>{"Integrations"}</a>
                <a href={"#faq"}>{"Help"}</a>
              </nav>
              <div className={"st-nav-end"}>
                <button
                  type={"button"}
                  className={"st-icon"}
                  aria-label={"Light theme"}
                  aria-pressed={v.isLight}
                  onClick={v.setLight}
                >
                  <svg
                    width={"16"}
                    height={"16"}
                    viewBox={"0 0 24 24"}
                    fill={"none"}
                    stroke={"currentColor"}
                    strokeWidth={"1.8"}
                    strokeLinecap={"round"}
                    strokeLinejoin={"round"}
                    aria-hidden={"true"}
                  >
                    <circle cx={"12"} cy={"12"} r={"4"}></circle>
                    <path
                      d={
                        "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
                      }
                    ></path>
                  </svg>
                </button>
                <button
                  type={"button"}
                  className={"st-icon"}
                  aria-label={"Dark theme"}
                  aria-pressed={v.isDark}
                  onClick={v.setDark}
                >
                  <svg
                    width={"16"}
                    height={"16"}
                    viewBox={"0 0 24 24"}
                    fill={"none"}
                    stroke={"currentColor"}
                    strokeWidth={"1.8"}
                    strokeLinecap={"round"}
                    strokeLinejoin={"round"}
                    aria-hidden={"true"}
                  >
                    <path d={"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"}></path>
                  </svg>
                </button>
                <a
                  className={"st-icon"}
                  href={links.repository}
                  aria-label={"ticketd on GitHub"}
                >
                  <svg
                    width={"18"}
                    height={"18"}
                    viewBox={"0 0 24 24"}
                    fill={"none"}
                    stroke={"currentColor"}
                    strokeWidth={"1.8"}
                    strokeLinecap={"round"}
                    strokeLinejoin={"round"}
                    aria-hidden={"true"}
                    dangerouslySetInnerHTML={{ __html: markup[1] }}
                  />
                </a>
              </div>
            </div>
          </header>
          <main className={"st-sheet"}>
            <section
              className={"st-hero st-pano"}
              aria-labelledby={"st-title"}
              data-sheet={"top"}
            >
              <div className={"st-hero-copy"}>
                <p className={"st-plate"} data-on={"true"}>
                  <i aria-hidden={"true"}></i>
                  <span>{"ticketd · local ticket workspace"}</span>
                </p>
                <h1 className={"st-h1"} id={"st-title"}>
                  {"A ticket factory on your computer, "}
                  <span className={"st-accent"}>{"powered by your AI"}</span>
                  {"."}
                </h1>
                <p className={"st-lead"}>
                  {
                    "ticketd is a ticket workspace on your computer. Your coding agent creates, updates and reads tickets through the CLI. You watch every change in the desktop app and decide what gets built next."
                  }
                </p>
                <div className={"st-hero-ctas"}>
                  <a className={"st-btn st-btn-primary"} href={links.install}>
                    {"Get started"}
                  </a>
                  <a className={"st-link"} href={links.repository}>
                    {"View on GitHub ↗"}
                  </a>
                </div>
                <p className={"st-runs"}>
                  {"Desktop app and CLI for "}
                  <b>{"macOS 26"}</b>
                  {" on Apple Silicon, "}
                  <b>{"Ubuntu 24.04"}</b>
                  {" and "}
                  <b>{"Windows 11"}</b>
                  {"."}
                </p>
              </div>
              <div className={"st-hero-art"}>
                <div className={"st-scene"}>
                  <div
                    className="st-panorama"
                    tabIndex={0}
                    role="region"
                    aria-label="Factory drawing"
                  >
                    <svg
                      className={"x-art pano"}
                      viewBox={"0 0 1360 520"}
                      data-run={v.hero.run}
                      data-made={v.hero.made}
                      data-read={v.hero.read}
                      data-hot={v.hero.hot}
                      aria-hidden={"true"}
                      dangerouslySetInnerHTML={{ __html: markup[2] }}
                    />
                    <p
                      className={"st-say"}
                      data-k={v.hero.k}
                      aria-live={"polite"}
                    >
                      <span className={"st-say-text"}>{v.hero.say}</span>
                      <i aria-hidden={"true"}></i>
                    </p>
                    <button
                      type={"button"}
                      className={"st-hot"}
                      style={{
                        left: "2%",
                        top: "12%",
                        width: "18%",
                        height: "58%",
                      }}
                      aria-label={"The AI power core. Make a ticket"}
                      onClick={v.hero.make}
                      onMouseEnter={v.hero.hotCore}
                      onFocus={v.hero.hotCore}
                      onMouseLeave={v.hero.cold}
                      onBlur={v.hero.cold}
                    >
                      <span className={"st-tip"}>
                        {"AI power · your agent’s model"}
                      </span>
                    </button>
                    <button
                      type={"button"}
                      className={"st-hot"}
                      style={{
                        left: "22%",
                        top: "30%",
                        width: "24%",
                        height: "40%",
                      }}
                      aria-label={"The press. Make a ticket"}
                      onClick={v.hero.make}
                      onMouseEnter={v.hero.hotPress}
                      onFocus={v.hero.hotPress}
                      onMouseLeave={v.hero.cold}
                      onBlur={v.hero.cold}
                    >
                      <span className={"st-tip"}>
                        {"ticketd document create-ticket"}
                      </span>
                    </button>
                    <button
                      type={"button"}
                      className={"st-hot"}
                      style={{
                        left: "40.5%",
                        top: "74%",
                        width: "12%",
                        height: "20%",
                      }}
                      aria-label={"The reader. Read a ticket"}
                      onClick={v.hero.readFn}
                      onMouseEnter={v.hero.hotReader}
                      onFocus={v.hero.hotReader}
                      onMouseLeave={v.hero.cold}
                      onBlur={v.hero.cold}
                    >
                      <span className={"st-tip"}>{"ticketd context T-12"}</span>
                    </button>
                  </div>
                  <figure className={"st-win st-appwin"}>
                    <div className={"st-win-bar"} aria-hidden={"true"}>
                      <span>{"your app · Ready"}</span>
                      <em>
                        <i></i>
                      </em>
                    </div>
                    <AppReady
                      ready={v.hero.ready}
                      fresh={v.hero.fresh}
                      crop={v.hero.crop}
                      theme={v.theme}
                    ></AppReady>
                    <figcaption className={"st-sr"}>{v.hero.sr}</figcaption>
                  </figure>
                </div>
                <div className={"st-hero-ctl"}>
                  <button
                    type={"button"}
                    className={"st-btn st-btn-ghost"}
                    aria-pressed={v.hero.isMake}
                    onClick={v.hero.make}
                  >
                    {"Make a ticket "}
                    <small>{"context in, ticket out"}</small>
                  </button>
                  <button
                    type={"button"}
                    className={"st-btn st-btn-ghost"}
                    aria-pressed={v.hero.isRead}
                    onClick={v.hero.readFn}
                  >
                    {"Read a ticket "}
                    <small>{"ticket in, context out"}</small>
                  </button>
                  <p className={"st-fine"}>{v.hero.status}</p>
                </div>
              </div>
              <div className={"st-ruler-row"}>
                <div className={"st-ruler"} aria-hidden={"true"}>
                  <span style={{ left: "0%" }}>{"0"}</span>
                  <span style={{ left: "16.667%" }}>{"2"}</span>
                  <span style={{ left: "33.333%" }}>{"4"}</span>
                  <span style={{ left: "50%" }}>{"6"}</span>
                  <span style={{ left: "66.667%" }}>{"8"}</span>
                  <span style={{ left: "83.333%" }}>{"10"}</span>
                  <span style={{ left: "100%" }}>{"12 m"}</span>
                </div>
                <div className={"st-tb"}>
                  <p>{"ticketd works"}</p>
                  <dl>
                    <div>
                      <dt>{"dwg"}</dt>
                      <dd>{"00 · the factory"}</dd>
                    </div>
                    <div>
                      <dt>{"sheet"}</dt>
                      <dd>{"1 of 8"}</dd>
                    </div>
                    <div>
                      <dt>{"scale"}</dt>
                      <dd>{"nts"}</dd>
                    </div>
                    <div>
                      <dt>{"rev"}</dt>
                      <dd>{"5c1a242"}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </section>
            <section
              className={"st-sec st-demo"}
              id={"line"}
              data-sheet={"line"}
              aria-labelledby={"st-line-title"}
              data-view={"line"}
              ref={v.views.line}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"01"}</b>
                      {" · The line"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.line.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.line.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-line-title"}>
                    {"Every machine on the line is a "}
                    <span className={"st-accent"}>{"ticketd"}</span>
                    {" command."}
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "Your agent runs the line from the CLI: it writes the spec, plans the work, cuts the tickets, wires them together and reports progress. Each change lands in your desktop app as it happens."
                  }
                </p>
              </div>
              <svg
                className={"st-cable"}
                data-p={v.pulse.line}
                aria-hidden={"true"}
              >
                <path className={"st-cable-line"} d={v.cables.line}></path>
                <path
                  className={"st-cable-run"}
                  d={v.cables.line}
                  pathLength={"100"}
                ></path>
              </svg>
              <div
                className={"st-line"}
                data-cable-from={"line"}
                data-cable-y={"0.776"}
              >
                <svg
                  className={"x-art"}
                  viewBox={"0 0 1114 330"}
                  data-hot={v.line.hot}
                  data-step={v.line.step}
                  data-run={v.line.running}
                  data-d0={v.line.d0}
                  data-d1={v.line.d1}
                  data-d2={v.line.d2}
                  data-d3={v.line.d3}
                  data-d4={v.line.d4}
                  style={{ "--rx": v.line.rx + "px" }}
                  aria-hidden={"true"}
                  dangerouslySetInnerHTML={{ __html: markup[3] }}
                />
                {v.line.stations.map((m, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-stn"}
                      style={{
                        left: m.left,
                        top: "18%",
                        width: "15.9%",
                        height: "64%",
                      }}
                      aria-label={m.label}
                      onClick={m.pick}
                      onMouseEnter={m.hot}
                      onFocus={m.hot}
                      onMouseLeave={v.line.cold}
                      onBlur={v.line.cold}
                    >
                      <span className={"st-tip"}>{m.tip}</span>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div
                className={"st-tabs"}
                role={"group"}
                aria-label={"Machines on the line"}
              >
                {v.line.stations.map((m, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-tab"}
                      aria-pressed={m.on}
                      data-done={m.done}
                      onClick={m.pick}
                    >
                      <b>
                        <span>{m.num}</span>
                        {m.name}
                      </b>
                      <small>{m.cmd}</small>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div className={"st-bar"}>
                <button
                  type={"button"}
                  className={"st-btn st-btn-primary"}
                  onClick={v.line.runAll}
                >
                  {v.line.runLabel}
                </button>
                <div
                  className={"st-seg"}
                  role={"group"}
                  aria-label={"Who runs the machines"}
                >
                  <button
                    type={"button"}
                    aria-pressed={v.line.isAgent}
                    onClick={v.line.setAgent}
                  >
                    {"your agent"}
                  </button>
                  <button
                    type={"button"}
                    aria-pressed={v.line.isYou}
                    onClick={v.line.setYou}
                  >
                    {"you, in the app"}
                  </button>
                </div>
                <p aria-live={"polite"}>
                  <b>{v.line.title}</b>
                  {v.line.say}
                </p>
              </div>
              <div className={"st-stage"}>
                <figure className={"st-win st-term"}>
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{v.line.termTitle}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <div
                    className={"st-tbody"}
                    tabIndex={0}
                    role={"region"}
                    aria-label={"Line command and output"}
                  >
                    {v.line.lines.map((ln, index) => (
                      <Fragment key={index}>
                        <div className={ln.cls} data-new={ln.isNew}>
                          <span className={"st-prompt"} aria-hidden={"true"}>
                            {ln.prompt}
                          </span>
                          {ln.text}
                          {ln.copy ? (
                            <>
                              <button
                                type={"button"}
                                className={"st-copy"}
                                aria-label={"Copy this command"}
                                onClick={ln.copyIt}
                              >
                                {ln.copyText}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Fragment>
                    ))}
                    {v.line.cursor ? (
                      <>
                        <div className={"st-tl st-tl-cmd"}>
                          <span className={"st-prompt"} aria-hidden={"true"}>
                            {"$ "}
                          </span>
                          <span className={"st-cursor"}></span>
                        </div>
                      </>
                    ) : null}
                  </div>
                </figure>
                <figure
                  className={"st-win"}
                  data-cable-to={"line"}
                  data-pulse={v.pulse.line}
                >
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"ticketd desktop app · " + v.line.appTitle}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <AppLine
                    screen={v.line.screen}
                    hl={v.line.hl}
                    theme={v.theme}
                  ></AppLine>
                  <figcaption className={"st-cap"}>
                    <b>{v.line.capLabel}</b>
                    <span>{v.line.cap}</span>
                  </figcaption>
                </figure>
              </div>
              <details className={"st-notes"}>
                <summary>{"Drawing notes & recording details"}</summary>
                <div className={"st-dwg"}>
                  <ol className={"st-legend"}>
                    <li>
                      <b>{"1"}</b>
                      <span>
                        <em>{"AI power."}</em>
                        {" Your agent’s model runs every machine."}
                      </span>
                    </li>
                    <li>
                      <b>{"2"}</b>
                      <span>
                        <em>{"Lamp."}</em>
                        {" Lights while that machine’s command runs."}
                      </span>
                    </li>
                    <li>
                      <b>{"3"}</b>
                      <span>
                        <em>{"Belt."}</em>
                        {" Carries T-12 from spec to progress update."}
                      </span>
                    </li>
                    <li>
                      <b>{"4"}</b>
                      <span>
                        <em>{"Status stamp."}</em>
                        {" Sets the status and records the agent’s update."}
                      </span>
                    </li>
                  </ol>
                  <div className={"st-tb"}>
                    <p>{"ticketd works"}</p>
                    <dl>
                      <div>
                        <dt>{"dwg"}</dt>
                        <dd>{"01 · the line"}</dd>
                      </div>
                      <div>
                        <dt>{"sheet"}</dt>
                        <dd>{"2 of 8"}</dd>
                      </div>
                      <div>
                        <dt>{"scale"}</dt>
                        <dd>{"nts"}</dd>
                      </div>
                      <div>
                        <dt>{"rev"}</dt>
                        <dd>{"5c1a242"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <p className={"st-fine"} style={{ marginTop: "16px" }}>
                  {
                    "A recorded run: every command and its output are real, from the ticketd CLI on main, and the screens are the desktop app captured during the same run. "
                  }
                  <code>{"jq"}</code>
                  {" only trims the JSON that ticketd prints."}
                </p>
              </details>
            </section>
            <section
              className={"st-sec"}
              id={"monitor"}
              data-sheet={"mon"}
              aria-labelledby={"st-mon-title"}
              data-view={"monitor"}
              ref={v.views.monitor}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"02"}</b>
                      {" · The monitor"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.mon.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.mon.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-mon-title"}>
                    {"See what every agent is doing, on the factory’s "}
                    <span className={"st-accent"}>{"monitor"}</span>
                    {"."}
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "The desktop app is the monitoring screen. Tickets by status, the Plan’s progress, the workspace graph, each ticket’s Activity and your Inbox change as your agents work. Play the shift, or switch channels."
                  }
                </p>
              </div>
              <div className={"mo2"}>
                <div className={"mo2-stage"}>
                  <svg
                    className={"x-art"}
                    viewBox={"0 0 900 620"}
                    data-live={v.mon.live}
                    style={{ "--ch": v.mon.chDeg, "--t": v.mon.tDeg }}
                    aria-hidden={"true"}
                    dangerouslySetInnerHTML={{ __html: markup[4] }}
                  />
                  <div className={"mo2-screen"} data-flick={v.mon.flick}>
                    <AppMonitor
                      screen={v.mon.screen}
                      go={v.mon.go}
                      theme={v.theme}
                    ></AppMonitor>
                  </div>
                  <p className={"mo2-readout"} aria-hidden={"true"}>
                    {"CH" + v.mon.n + " · " + v.mon.chName}
                  </p>
                  <div
                    className={"mo2-knob"}
                    role={"slider"}
                    tabIndex={"0"}
                    aria-label={"Channel"}
                    aria-valuemin={"1"}
                    aria-valuemax={"5"}
                    aria-valuenow={v.mon.n}
                    aria-valuetext={v.mon.chName}
                    style={{ left: "69.556%", top: "87.097%" }}
                    onPointerDown={v.mon.kch.down}
                    onPointerMove={v.mon.kch.move}
                    onPointerUp={v.mon.kch.up}
                    onPointerCancel={v.mon.kch.up}
                    onKeyDown={v.mon.kch.key}
                  >
                    <span className={"st-tip"}>
                      {"Channel · drag, or use the arrow keys"}
                    </span>
                  </div>
                  <div
                    className={"mo2-knob"}
                    role={"slider"}
                    tabIndex={"0"}
                    aria-label={"Moment in the shift"}
                    aria-valuemin={"0"}
                    aria-valuemax={"3"}
                    aria-valuenow={v.mon.k}
                    aria-valuetext={v.mon.tText}
                    style={{ left: "78.667%", top: "87.097%" }}
                    onPointerDown={v.mon.kt.down}
                    onPointerMove={v.mon.kt.move}
                    onPointerUp={v.mon.kt.up}
                    onPointerCancel={v.mon.kt.up}
                    onKeyDown={v.mon.kt.key}
                  >
                    <span className={"st-tip"}>
                      {"Time · drag, or use the arrow keys"}
                    </span>
                  </div>
                  <p className={"st-sr"} aria-live={"polite"}>
                    {v.mon.sr}
                  </p>
                </div>
                <aside className={"mo2-side"}>
                  <div
                    className={"mo2-inbox"}
                    role={"img"}
                    aria-label={v.mon.inboxLabel}
                  >
                    <span>{"Inbox"}</span>
                    <b>{v.mon.inbox}</b>
                    <small>{v.mon.inboxNote}</small>
                  </div>
                  <p className={"st-kicker"}>{"Shift log"}</p>
                  <ol className={"mo2-log"}>
                    {v.mon.events.map((e, index) => (
                      <Fragment key={index}>
                        <li>
                          <button
                            type={"button"}
                            className={"mo2-ev"}
                            data-state={e.state}
                            data-bell={e.bell}
                            onClick={e.go}
                          >
                            <time>{e.t}</time>
                            <span>
                              <b>{e.who}</b>
                              {" " + e.text}
                            </span>
                          </button>
                        </li>
                      </Fragment>
                    ))}
                  </ol>
                </aside>
              </div>
              <div
                className={"st-tabs st-tabs-5"}
                role={"group"}
                aria-label={"Channels"}
              >
                {v.mon.channels.map((c, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-tab"}
                      aria-pressed={c.on}
                      onClick={c.pick}
                    >
                      <b>
                        <span>{c.n}</span>
                        {c.name}
                      </b>
                      <small>{c.hint}</small>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div className={"mo2-deck"}>
                <button
                  type={"button"}
                  className={"st-btn st-btn-ghost st-btn-sq"}
                  aria-label={"Back to the start of the shift"}
                  onClick={v.mon.rewind}
                >
                  <svg
                    width={"14"}
                    height={"14"}
                    viewBox={"0 0 16 16"}
                    shapeRendering={"crispEdges"}
                    aria-hidden={"true"}
                  >
                    <path
                      fill={"currentColor"}
                      d={"M2 3h2v10H2zM5 8l5-5v10zM10 8l5-5v10z"}
                    ></path>
                  </svg>
                </button>
                <button
                  type={"button"}
                  className={"st-btn st-btn-primary"}
                  onClick={v.mon.toggle}
                >
                  {v.mon.playing ? (
                    <>
                      <svg
                        width={"14"}
                        height={"14"}
                        viewBox={"0 0 16 16"}
                        shapeRendering={"crispEdges"}
                        aria-hidden={"true"}
                      >
                        <path
                          fill={"currentColor"}
                          d={"M3 2h4v12H3zM9 2h4v12H9z"}
                        ></path>
                      </svg>
                    </>
                  ) : null}
                  {v.mon.paused ? (
                    <>
                      <svg
                        width={"14"}
                        height={"14"}
                        viewBox={"0 0 16 16"}
                        shapeRendering={"crispEdges"}
                        aria-hidden={"true"}
                      >
                        <path
                          fill={"currentColor"}
                          d={"M4 2l10 6-10 6z"}
                        ></path>
                      </svg>
                    </>
                  ) : null}
                  <span>{v.mon.playText}</span>
                </button>
                <button
                  type={"button"}
                  className={"st-btn st-btn-ghost st-btn-sq"}
                  aria-label={"Next change"}
                  onClick={v.mon.next}
                >
                  <svg
                    width={"14"}
                    height={"14"}
                    viewBox={"0 0 16 16"}
                    shapeRendering={"crispEdges"}
                    aria-hidden={"true"}
                  >
                    <path
                      fill={"currentColor"}
                      d={"M1 3l5 5-5 5zM6 3l5 5-5 5zM12 3h2v10h-2z"}
                    ></path>
                  </svg>
                </button>
                <label className={"mo2-track"}>
                  <span className={"st-sr"}>{"Shift position"}</span>
                  <input
                    className={"mo2-range"}
                    type={"range"}
                    min={"0"}
                    max={"3"}
                    step={"1"}
                    value={v.mon.k}
                    onChange={v.mon.seek}
                  />
                  <span className={"mo2-stops"} aria-hidden={"true"}>
                    <span>{"00:00"}</span>
                    <span>{"00:12"}</span>
                    <span>{"00:24"}</span>
                    <span>{"00:38"}</span>
                  </span>
                </label>
                <p className={"mo2-status"} aria-live={"polite"}>
                  {v.mon.status}
                </p>
              </div>
              <details className={"st-notes"}>
                <summary>{"Drawing notes & recording details"}</summary>
                <div className={"st-dwg"}>
                  <ol className={"st-legend"}>
                    <li>
                      <b>{"1"}</b>
                      <span>
                        <em>{"Screen."}</em>
                        {" The real desktop app, recorded on one run."}
                      </span>
                    </li>
                    <li>
                      <b>{"2"}</b>
                      <span>
                        <em>{"Channel."}</em>
                        {" Tickets, Plan, Graph, Ticket, Inbox."}
                      </span>
                    </li>
                    <li>
                      <b>{"3"}</b>
                      <span>
                        <em>{"Time."}</em>
                        {" Four moments of the shift."}
                      </span>
                    </li>
                    <li>
                      <b>{"4"}</b>
                      <span>
                        <em>{"Live."}</em>
                        {" Lights when the workspace changes."}
                      </span>
                    </li>
                    <li>
                      <b>{"5"}</b>
                      <span>
                        <em>{"Camera."}</em>
                        {" An open app shows CLI changes within seconds."}
                      </span>
                    </li>
                  </ol>
                  <div className={"st-tb"}>
                    <p>{"ticketd works"}</p>
                    <dl>
                      <div>
                        <dt>{"dwg"}</dt>
                        <dd>{"02 · the monitor"}</dd>
                      </div>
                      <div>
                        <dt>{"sheet"}</dt>
                        <dd>{"3 of 8"}</dd>
                      </div>
                      <div>
                        <dt>{"scale"}</dt>
                        <dd>{"nts"}</dd>
                      </div>
                      <div>
                        <dt>{"rev"}</dt>
                        <dd>{"5c1a242"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <p className={"st-fine"} style={{ marginTop: "16px" }}>
                  {
                    "A recorded run, replayed. Agent names are the labels an agent passes with "
                  }
                  <code>{"--agent"}</code>
                  {
                    "; ticketd records them but doesn’t verify them. Your own edits never ring your Inbox."
                  }
                </p>
              </details>
            </section>
            <section
              className={"st-sec"}
              id={"dispatch"}
              data-sheet={"disp"}
              aria-labelledby={"st-disp-title"}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"03"}</b>
                      {" · Dispatch"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.disp.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.disp.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-disp-title"}>
                    {"Decide what your agent "}
                    <span className={"st-accent"}>{"picks up"}</span>
                    {" next."}
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "Chain a ticket to the work it waits on. ticketd works out what’s Ready, and your agent asks for Ready tickets only. Mark a blocker Done or unhook a chain, then let the agent ask for work."
                  }
                </p>
              </div>
              <div className={"dp2"}>
                <div className={"dp2-rows"}>
                  {v.disp.rows.map((r, index) => (
                    <Fragment key={index}>
                      <div
                        className={"dp2-row"}
                        data-chain={r.chain}
                        data-dragging={r.dragging}
                      >
                        <div className={"dp2-card"} data-avail={r.bAvail}>
                          <span className={"dp2-ref"}>
                            <i data-tone={r.bTone}></i>
                            {r.from}
                          </span>
                          <span className={"dp2-title"}>{r.fromTitle}</span>
                          <span className={"dp2-state"}>{r.fromState}</span>
                        </div>
                        <button
                          type={"button"}
                          role={"switch"}
                          className={"dp2-done"}
                          aria-checked={r.done}
                          aria-label={r.doneLabel}
                          onClick={r.toggleDone}
                        >
                          <span className={"dp2-track"}>
                            <span></span>
                          </span>
                          {"Done"}
                        </button>
                        <div className={"dp2-chain"}>
                          <svg
                            className={"dp2-grab"}
                            viewBox={"0 0 160 40"}
                            aria-hidden={"true"}
                            onPointerDown={r.drag.down}
                            onPointerMove={r.drag.move}
                            onPointerUp={r.drag.up}
                            onPointerCancel={r.drag.cancel}
                            dangerouslySetInnerHTML={{ __html: markup[5] }}
                          />
                          <button
                            type={"button"}
                            className={"dp2-hook"}
                            aria-label={r.hookLabel}
                            onClick={r.toggleHook}
                          >
                            {r.hookText}
                          </button>
                        </div>
                        <div
                          className={"dp2-card"}
                          data-avail={r.tAvail}
                          data-end={"to"}
                          data-drop={r.dropOn}
                        >
                          <span className={"dp2-ref"}>
                            <i data-tone={r.tTone}></i>
                            {r.to}
                          </span>
                          <span className={"dp2-title"}>{r.toTitle}</span>
                          <span className={"dp2-state"}>{r.toState}</span>
                        </div>
                        <svg className={"dp2-band"} aria-hidden={"true"}>
                          {r.dragging ? (
                            <>
                              <path d={r.band}></path>
                            </>
                          ) : null}
                        </svg>
                      </div>
                    </Fragment>
                  ))}
                </div>
                <div className={"dp2-tray"}>
                  <p className={"st-kicker"}>{"Ready tray"}</p>
                  <div
                    className={"dp2-belt"}
                    data-cable-from={"disp"}
                    data-cable-y={"0.576"}
                  >
                    <svg
                      className={"x-art"}
                      viewBox={"0 -24 700 110"}
                      aria-hidden={"true"}
                      dangerouslySetInnerHTML={{ __html: markup[6] }}
                    />
                    <div className={"dp2-chips"}>
                      {v.disp.tray.map((t, index) => (
                        <Fragment key={index}>
                          <span className={"dp2-chip"} data-picked={t.picked}>
                            {t.ref}
                          </span>
                        </Fragment>
                      ))}
                    </div>
                    <span
                      className={"dp2-cat"}
                      data-pose={v.disp.pose}
                      aria-hidden={"true"}
                    >
                      <svg
                        viewBox={"0 0 28 25"}
                        shapeRendering={"crispEdges"}
                        aria-hidden={"true"}
                        dangerouslySetInnerHTML={{ __html: markup[7] }}
                      />
                    </span>
                  </div>
                  <div className={"st-bar"} style={{ marginTop: "12px" }}>
                    <button
                      type={"button"}
                      className={"st-btn st-btn-primary"}
                      onClick={v.disp.ask}
                    >
                      {"Agent asks for work "}
                      <small>{"list --availability ready --limit 1"}</small>
                    </button>
                    <p aria-live={"polite"}>{v.disp.say}</p>
                  </div>
                </div>
              </div>
              <svg
                className={"st-cable"}
                data-p={v.pulse.disp}
                aria-hidden={"true"}
              >
                <path className={"st-cable-line"} d={v.cables.disp}></path>
                <path
                  className={"st-cable-run"}
                  d={v.cables.disp}
                  pathLength={"100"}
                ></path>
              </svg>
              <div className={"st-stage dp2-stage"}>
                <figure className={"st-win st-term"}>
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"your agent · ~/code/web-app"}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <div
                    className={"st-tbody dp2-term"}
                    tabIndex={0}
                    role={"region"}
                    aria-label={"Dispatch command and output"}
                  >
                    {v.disp.lines.map((ln, index) => (
                      <Fragment key={index}>
                        <div className={ln.cls}>
                          <span className={"st-prompt"} aria-hidden={"true"}>
                            {ln.prompt}
                          </span>
                          {ln.text}
                          {ln.copy ? (
                            <>
                              <button
                                type={"button"}
                                className={"st-copy"}
                                aria-label={"Copy this command"}
                                onClick={ln.copyIt}
                              >
                                {ln.copyText}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </figure>
                <figure
                  className={"st-win"}
                  data-cable-to={"disp"}
                  data-pulse={v.pulse.disp}
                >
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"ticketd desktop app · Ready"}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <AppReady
                    ready={v.disp.ready}
                    fresh={v.disp.fresh}
                    crop={v.disp.crop}
                    theme={v.theme}
                  ></AppReady>
                  <figcaption className={"st-cap"}>
                    <b>{"Ready"}</b>
                    <span>{v.disp.cap}</span>
                  </figcaption>
                </figure>
              </div>
              <details className={"st-notes"}>
                <summary>{"Drawing notes & recording details"}</summary>
                <div className={"st-dwg"}>
                  <ol className={"st-legend"}>
                    <li>
                      <b>{"1"}</b>
                      <span>
                        <em>{"Ready tray."}</em>
                        {" Only Ready tickets ride it."}
                      </span>
                    </li>
                    <li>
                      <b>{"2"}</b>
                      <span>
                        <em>{"First in line."}</em>
                        {" What --limit 1 hands out."}
                      </span>
                    </li>
                    <li>
                      <b>{"3"}</b>
                      <span>
                        <em>{"Your agent."}</em>
                        {" Asks for work and gets one ticket."}
                      </span>
                    </li>
                  </ol>
                  <div className={"st-tb"}>
                    <p>{"ticketd works"}</p>
                    <dl>
                      <div>
                        <dt>{"dwg"}</dt>
                        <dd>{"03 · dispatch"}</dd>
                      </div>
                      <div>
                        <dt>{"sheet"}</dt>
                        <dd>{"4 of 8"}</dd>
                      </div>
                      <div>
                        <dt>{"scale"}</dt>
                        <dd>{"nts"}</dd>
                      </div>
                      <div>
                        <dt>{"rev"}</dt>
                        <dd>{"5c1a242"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <p className={"st-fine"} style={{ marginTop: "16px" }}>
                  {
                    "Ready is worked out the way ticketd does it: a Todo ticket with no unresolved blocking dependency, and only Done resolves one. Readiness guides what gets picked; it never stops anyone from starting."
                  }
                </p>
              </details>
            </section>
            <section
              className={"st-sec st-demo"}
              id={"assembly"}
              data-sheet={"asm"}
              aria-labelledby={"st-asm-title"}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"04"}</b>
                      {" · Assembly"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.asm.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.asm.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-asm-title"}>
                    {"Bolt the "}
                    <span className={"st-accent"}>{"plan"}</span>
                    {", notes and proof onto the ticket."}
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "Documents, updates, evidence and blockers stay attached to the ticket they explain. You review them in the app, and your agent’s next session asks for just the parts it needs."
                  }
                </p>
              </div>
              <svg
                className={"st-cable"}
                data-p={v.pulse.asm}
                aria-hidden={"true"}
              >
                <path className={"st-cable-line"} d={v.cables.asm}></path>
                <path
                  className={"st-cable-run"}
                  d={v.cables.asm}
                  pathLength={"100"}
                ></path>
              </svg>
              <div
                className={"as2"}
                data-cable-from={"asm"}
                data-cable-y={"0.86"}
              >
                <svg
                  className={"x-art"}
                  viewBox={"0 0 960 284"}
                  style={{ "--needle": v.asm.needle }}
                  data-hot={v.asm.hot}
                  data-p0={v.asm.p0}
                  data-p1={v.asm.p1}
                  data-p2={v.asm.p2}
                  data-p3={v.asm.p3}
                  data-p4={v.asm.p4}
                  data-ship={v.asm.ship}
                  aria-hidden={"true"}
                  dangerouslySetInnerHTML={{ __html: markup[8] }}
                />
                {v.asm.flags.map((f, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-stn"}
                      style={{
                        left: f.left,
                        top: "9%",
                        width: "11.2%",
                        height: "41%",
                      }}
                      aria-label={f.label}
                      aria-pressed={f.on}
                      onClick={f.toggle}
                      onMouseEnter={f.hot}
                      onFocus={f.hot}
                      onMouseLeave={v.asm.cold}
                      onBlur={v.asm.cold}
                    >
                      <span className={"st-tip"}>{f.tip}</span>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div
                className={"st-tabs st-tabs-5"}
                role={"group"}
                aria-label={"Parts to attach to T-12"}
              >
                {v.asm.flags.map((f, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      role={"switch"}
                      className={"st-tab as2-part"}
                      aria-checked={f.on}
                      onClick={f.toggle}
                    >
                      <b>
                        <span></span>
                        {f.short}
                      </b>
                      <small>{f.flag}</small>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div className={"st-bar"}>
                <button
                  type={"button"}
                  className={"st-push"}
                  onClick={v.asm.shipIt}
                >
                  <i aria-hidden={"true"}></i>
                  <span>{"Ship to the agent"}</span>
                </button>
                <p aria-live={"polite"}>
                  <b>{v.asm.count + " of 5 parts."}</b>
                  {v.asm.say}
                </p>
              </div>
              <div className={"st-stage"}>
                <figure className={"st-win st-term"}>
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"your agent · ~/code/web-app"}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <div
                    className={"st-tbody as2-term"}
                    tabIndex={0}
                    role={"region"}
                    aria-label={"Assembly command and output"}
                  >
                    {v.asm.lines.map((ln, index) => (
                      <Fragment key={index}>
                        <div className={ln.cls}>
                          <span className={"st-prompt"} aria-hidden={"true"}>
                            {ln.prompt}
                          </span>
                          {ln.text}
                          {ln.copy ? (
                            <>
                              <button
                                type={"button"}
                                className={"st-copy"}
                                aria-label={"Copy this command"}
                                onClick={ln.copyIt}
                              >
                                {ln.copyText}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </figure>
                <figure
                  className={"st-win"}
                  data-cable-to={"asm"}
                  data-pulse={v.pulse.asm}
                >
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"ticketd desktop app · T-12"}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <AppTicket
                    hl={v.asm.hl}
                    view={"760"}
                    theme={v.theme}
                  ></AppTicket>
                  <figcaption className={"st-cap"}>
                    <b>{"You read"}</b>
                    <span>{v.asm.cap}</span>
                  </figcaption>
                </figure>
              </div>
              <details className={"st-notes"}>
                <summary>{"Drawing notes"}</summary>
                <div className={"st-dwg"}>
                  <ol className={"st-legend"}>
                    <li>
                      <b>{"1"}</b>
                      <span>
                        <em>{"Hoppers."}</em>
                        {" One per ticketd context option."}
                      </span>
                    </li>
                    <li>
                      <b>{"2"}</b>
                      <span>
                        <em>{"T-12."}</em>
                        {" The ticket being read."}
                      </span>
                    </li>
                    <li>
                      <b>{"3"}</b>
                      <span>
                        <em>{"Crate."}</em>
                        {" Exactly what your agent receives."}
                      </span>
                    </li>
                    <li>
                      <b>{"4"}</b>
                      <span>
                        <em>{"Gauge."}</em>
                        {" " + v.asm.bytes + " bytes of JSON right now."}
                      </span>
                    </li>
                    <li>
                      <b>{"5"}</b>
                      <span>
                        <em>{"Arm."}</em>
                        {" Ships the crate to the next session."}
                      </span>
                    </li>
                  </ol>
                  <div className={"st-tb"}>
                    <p>{"ticketd works"}</p>
                    <dl>
                      <div>
                        <dt>{"dwg"}</dt>
                        <dd>{"04 · assembly"}</dd>
                      </div>
                      <div>
                        <dt>{"sheet"}</dt>
                        <dd>{"5 of 8"}</dd>
                      </div>
                      <div>
                        <dt>{"scale"}</dt>
                        <dd>{"nts"}</dd>
                      </div>
                      <div>
                        <dt>{"rev"}</dt>
                        <dd>{"5c1a242"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </details>
            </section>
            <section
              className={"st-sec st-demo"}
              id={"dock"}
              data-sheet={"dock"}
              aria-labelledby={"st-dock-title"}
              data-view={"dock"}
              ref={v.views.dock}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"05"}</b>
                      {" · The loading dock"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.dock.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.dock.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-dock-title"}>
                    {"Issues in from "}
                    <span className={"st-accent"}>{"GitHub"}</span>
                    {
                      ", proof in from git, the workspace kept on your computer."
                    }
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "The dock is where the factory meets the outside. Pick a bay: the shutter rolls up, the real command runs, and the app shows what came in or went out."
                  }
                </p>
              </div>
              <svg
                className={"st-cable"}
                data-p={v.pulse.dock}
                aria-hidden={"true"}
              >
                <path className={"st-cable-line"} d={v.cables.dock}></path>
                <path
                  className={"st-cable-run"}
                  d={v.cables.dock}
                  pathLength={"100"}
                ></path>
              </svg>
              <div
                className={"dk2"}
                data-cable-from={"dock"}
                data-cable-y={"0.5"}
              >
                <svg
                  className={"x-art"}
                  viewBox={"0 0 1320 300"}
                  data-peek={v.dock.peek}
                  data-o0={v.dock.o0}
                  data-o1={v.dock.o1}
                  data-o2={v.dock.o2}
                  data-o3={v.dock.o3}
                  data-o4={v.dock.o4}
                  aria-hidden={"true"}
                  dangerouslySetInnerHTML={{ __html: markup[9] }}
                />
                {v.dock.bays.map((b, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-stn"}
                      style={{
                        left: b.left,
                        top: "30.67%",
                        width: "15.45%",
                        height: "56%",
                      }}
                      aria-label={b.label}
                      onClick={b.pick}
                      onMouseEnter={b.hot}
                      onFocus={b.hot}
                      onMouseLeave={v.dock.cold}
                      onBlur={v.dock.cold}
                    >
                      <span className={"st-tip"}>{b.tip}</span>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div
                className={"st-tabs st-tabs-5"}
                role={"group"}
                aria-label={"Bays"}
              >
                {v.dock.bays.map((b, index) => (
                  <Fragment key={index}>
                    <button
                      type={"button"}
                      className={"st-tab"}
                      aria-pressed={b.on}
                      data-soon={b.soon}
                      onClick={b.pick}
                    >
                      <b>
                        <span>{b.n}</span>
                        {b.name}
                      </b>
                      <small>{b.cmd}</small>
                    </button>
                  </Fragment>
                ))}
              </div>
              <div className={"st-stage"}>
                <figure className={"st-win st-term"}>
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"~/code/web-app · " + v.dock.name}</span>
                    <em>
                      <i></i>
                    </em>
                  </div>
                  <div
                    className={"st-tbody dk2-term"}
                    tabIndex={0}
                    role={"region"}
                    aria-label={"Dock command and output"}
                  >
                    {v.dock.lines.map((ln, index) => (
                      <Fragment key={index}>
                        <div className={ln.cls} data-new={"true"}>
                          <span className={"st-prompt"} aria-hidden={"true"}>
                            {ln.prompt}
                          </span>
                          {ln.text}
                          {ln.copy ? (
                            <>
                              <button
                                type={"button"}
                                className={"st-copy"}
                                aria-label={"Copy this command"}
                                onClick={ln.copyIt}
                              >
                                {ln.copyText}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </figure>
                <figure
                  className={"st-win"}
                  data-cable-to={"dock"}
                  data-pulse={v.pulse.dock}
                >
                  <div className={"st-win-bar"} aria-hidden={"true"}>
                    <span>{"ticketd desktop app · " + v.dock.appTitle}</span>
                    {v.dock.hasViews ? (
                      <>
                        <span
                          className={"st-seg dk2-views"}
                          role={"group"}
                          aria-label={"GitHub views"}
                        >
                          {v.dock.views.map((v, index) => (
                            <Fragment key={index}>
                              <button
                                type={"button"}
                                aria-pressed={v.on}
                                onClick={v.pick}
                              >
                                {v.name}
                              </button>
                            </Fragment>
                          ))}
                        </span>
                      </>
                    ) : null}
                    <em>
                      <i></i>
                    </em>
                  </div>
                  {v.dock.isSoon ? (
                    <>
                      <div className={"dk2-soon"}>
                        <b>{"Google Drive · coming soon"}</b>
                        <p>
                          {
                            "Attach files from Drive to tickets, or keep uploads in a Drive folder you choose. It’s being built and isn’t in a release yet, so there’s no screen to show."
                          }
                        </p>
                      </div>
                    </>
                  ) : null}
                  {v.dock.hasApp ? (
                    <>
                      <AppDock
                        screen={v.dock.screen}
                        go={v.dock.go}
                        hl={v.dock.hl}
                        theme={v.theme}
                      ></AppDock>
                    </>
                  ) : null}
                  <figcaption className={"st-cap"}>
                    <b>{v.dock.capLabel}</b>
                    <span>{v.dock.say}</span>
                  </figcaption>
                </figure>
              </div>
              <details className={"st-notes"}>
                <summary>{"Drawing notes & recording details"}</summary>
                <div className={"st-dwg"}>
                  <div className={"dk2-slip"} aria-live={"polite"}>
                    <p>
                      <b>{"Packing slip"}</b>
                      <span>{v.dock.slipHead}</span>
                    </p>
                    <ol>
                      {v.dock.slip.map((sl, index) => (
                        <Fragment key={index}>
                          <li>
                            <b>{sl.k}</b>
                            <span>{sl.v}</span>
                          </li>
                        </Fragment>
                      ))}
                    </ol>
                  </div>
                  <ol className={"st-legend"}>
                    <li>
                      <b>{"1"}</b>
                      <span>
                        <em>{"Bays."}</em>
                        {" One per connection."}
                      </span>
                    </li>
                    <li>
                      <b>{"2"}</b>
                      <span>
                        <em>{"Shutter."}</em>
                        {" Rolls up when you open a bay."}
                      </span>
                    </li>
                    <li>
                      <b>{"3"}</b>
                      <span>
                        <em>{"Lamp."}</em>
                        {" Lit while its bay is open."}
                      </span>
                    </li>
                  </ol>
                  <div className={"st-tb"}>
                    <p>{"ticketd works"}</p>
                    <dl>
                      <div>
                        <dt>{"dwg"}</dt>
                        <dd>{"05 · the dock"}</dd>
                      </div>
                      <div>
                        <dt>{"sheet"}</dt>
                        <dd>{"6 of 8"}</dd>
                      </div>
                      <div>
                        <dt>{"scale"}</dt>
                        <dd>{"nts"}</dd>
                      </div>
                      <div>
                        <dt>{"rev"}</dt>
                        <dd>{"5c1a242"}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <p className={"st-fine"} style={{ marginTop: "16px" }}>
                  {
                    "The GitHub screens come from a test account and repository (acme/web-app) served offline; the commands and their output are real."
                  }
                </p>
              </details>
            </section>
            <section
              className={"st-sec"}
              id={"faq"}
              data-sheet={"faq"}
              aria-labelledby={"st-faq-title"}
            >
              <div className={"st-sec-head"}>
                <div>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"06"}</b>
                      {" · Help"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.faq.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.faq.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-faq-title"}>
                    {"Questions before you "}
                    <span className={"st-accent"}>{"hand over"}</span>
                    {" a ticket."}
                  </h2>
                </div>
                <p className={"st-lead"}>
                  {
                    "The short answers. The install guide and the glossary have the long ones."
                  }
                </p>
              </div>
              <div className={"fq"}>
                <details open={v.yes}>
                  <summary>
                    {"Does ticketd control what my agent can run?"}
                  </summary>
                  <p>
                    {
                      "No. ticketd doesn’t sandbox your agent or approve its commands; your agent’s own permission settings still decide that. What ticketd gives you is control over the work: what’s ready, what the plan says and what your agent reported."
                    }
                  </p>
                </details>
                <details>
                  <summary>{"Which coding agents can use ticketd?"}</summary>
                  <p>
                    {
                      "Any agent or harness that can run shell commands and read their output. There’s no plugin or MCP server to install: your agent calls the "
                    }
                    <code>{"ticketd"}</code>
                    {
                      " CLI, which prints JSON. Describe the commands in its instructions, for example in AGENTS.md."
                    }
                  </p>
                </details>
                <details>
                  <summary>{"Where are my tickets stored?"}</summary>
                  <p>
                    {
                      "In a local workspace: a SQLite database in your user’s application-data folder, outside your repositories. The desktop app and the CLI open it directly, with no account, server or background service. Uninstalling keeps it, and "
                    }
                    <code>{"ticketd backup"}</code>
                    {" saves a copy."}
                  </p>
                </details>
                <details>
                  <summary>{"What do I need to install?"}</summary>
                  <p>
                    {"The desktop app and the "}
                    <code>{"ticketd"}</code>
                    {
                      " CLI. Each download has both, for macOS 26 on Apple Silicon, Ubuntu 24.04 (x86-64) or Windows 11 (x86-64). Put the CLI on the PATH your agent uses. Downloads are unsigned build artifacts for now, so your system may warn before opening them; the install guide walks through it."
                    }
                  </p>
                </details>
                <details>
                  <summary>
                    {"How is it different from my agent’s own to-do list?"}
                  </summary>
                  <p>
                    {
                      "An agent’s built-in plan or to-do list usually lives in its session. ticketd keeps tickets, Documents and updates in a local workspace that you can open in the app and any later session can read. It doesn’t run agents, assign work or orchestrate them."
                    }
                  </p>
                </details>
                <details>
                  <summary>{"Does the desktop app need to be open?"}</summary>
                  <p>
                    {
                      "No. The CLI opens the workspace on its own. When the app is open, it shows changes from the CLI within a couple of seconds."
                    }
                  </p>
                </details>
              </div>
            </section>
            <section
              className={"st-sec"}
              id={"start"}
              data-sheet={"start"}
              aria-labelledby={"st-start-title"}
              data-view={"start"}
              ref={v.views.start}
            >
              <div className={"sr3"} data-phase={v.start.phase}>
                <div className={"sr3-stage"} aria-hidden={"true"}>
                  <div className={"sr3-cam"}>
                    <svg
                      className={"x-art"}
                      viewBox={"0 0 900 620"}
                      data-live={"true"}
                      dangerouslySetInnerHTML={{ __html: markup[10] }}
                    />
                    <div className={"sr3-term"}>
                      <p className={"sr3-cmd"}>
                        <span>{"$ "}</span>
                        {v.start.typed}
                        <i data-on={v.start.cursor}></i>
                      </p>
                      <pre>{v.start.out}</pre>
                    </div>
                  </div>
                </div>
                <div className={"sr3-copy"}>
                  <div className={"st-kick"}>
                    <p className={"st-kicker"}>
                      <b>{"07"}</b>
                      {" · Start"}
                    </p>
                    <p className={"st-plate"} data-on={v.plate.start.on}>
                      <i aria-hidden={"true"}></i>
                      <span>{v.plate.start.text}</span>
                    </p>
                  </div>
                  <h2 className={"st-h2"} id={"st-start-title"}>
                    {"Put your next plan on the "}
                    <span className={"st-accent"}>{"line"}</span>
                    {"."}
                  </h2>
                  <p className={"st-lead"}>
                    {
                      "Install the desktop app and the CLI, then ask your agent to turn your plan into tickets. You’ll see them arrive in the app."
                    }
                  </p>
                  <div className={"st-hero-ctas"}>
                    <a className={"st-btn st-btn-primary"} href={links.install}>
                      {"Get started"}
                    </a>
                    <a className={"st-link"} href={links.repository}>
                      {"View on GitHub ↗"}
                    </a>
                    <button
                      type={"button"}
                      className={"st-link sr3-replay"}
                      onClick={v.start.replay}
                    >
                      {"Play it again"}
                    </button>
                  </div>
                  <p className={"st-fine"}>
                    {
                      "Downloads are unsigned build artifacts for macOS 26 on Apple Silicon, Ubuntu 24.04 and Windows 11, and platform validation is still outstanding. After installing, run "
                    }
                    <code>{"ticketd --help"}</code>
                    {" from the shell your agent uses."}
                  </p>
                  <button
                    type="button"
                    className="st-btn st-btn-ghost"
                    onClick={() => this.copy("ticketd --help", "start")}
                  >
                    {this.state.copyFailed === "start"
                      ? "Copy failed — select ticketd --help"
                      : this.state.copied === "start"
                        ? "Copied ticketd --help"
                        : "Copy ticketd --help"}
                  </button>
                </div>
              </div>
            </section>
            <footer className={"st-foot"} data-view={"foot"} ref={v.views.foot}>
              <div className={"st-foot-brand"}>
                <a className={"st-brand"} href={"#top"}>
                  <span>{"ticketd"}</span>
                </a>
                <p>
                  {
                    "A ticket factory on your computer, for people and their coding agents."
                  }
                </p>
              </div>
              <nav className={"st-foot-links"} aria-label={"See also"}>
                <p className={"st-kicker"}>{"See also"}</p>
                <a href={links.install}>{"Install guide"}</a>
                <a href={links.repository}>{"Repository"}</a>
                <a href={links.glossary}>{"Glossary"}</a>
              </nav>
              <p className={"st-foot-man"} aria-hidden={"true"}>
                {"ticketd(1)"}
              </p>
              <div className={"st-stub-wrap"}>
                <svg
                  className={"x-art st-stub"}
                  viewBox={"0 0 1400 276"}
                  data-punch={v.foot.punch}
                  role={"img"}
                  aria-label={"ticketd, punched through a ticket stub"}
                  dangerouslySetInnerHTML={{ __html: markup[11] }}
                />
              </div>
            </footer>
          </main>
          <div className={"st-status"}>
            <div className={"st-status-in"}>
              <p className={"st-status-log"}>
                <span className={"st-dot"} aria-hidden={"true"}></span>
                <span>{v.statusLine}</span>
              </p>
              <nav aria-label={"Sections"}>
                <a href={"#top"} aria-current={v.nav.top}>
                  {"00 Factory"}
                </a>
                <a href={"#line"} aria-current={v.nav.line}>
                  {"01 Line"}
                </a>
                <a href={"#monitor"} aria-current={v.nav.mon}>
                  {"02 Monitor"}
                </a>
                <a href={"#dispatch"} aria-current={v.nav.disp}>
                  {"03 Dispatch"}
                </a>
                <a href={"#assembly"} aria-current={v.nav.asm}>
                  {"04 Assembly"}
                </a>
                <a href={"#dock"} aria-current={v.nav.dock}>
                  {"05 Dock"}
                </a>
                <a href={"#faq"} aria-current={v.nav.faq}>
                  {"06 Help"}
                </a>
                <a href={"#start"} aria-current={v.nav.start}>
                  {"07 Start"}
                </a>
              </nav>
            </div>
          </div>
        </div>
      </>
    );
  }
}
