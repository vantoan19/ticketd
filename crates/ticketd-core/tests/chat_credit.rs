//! Write credit for sub-agents (format 105): which agent of a Chat made a status change or
//! an Activity through the `ticketd` CLI. Exact when the harness names the call; otherwise
//! by commit order, from the window each shell Step was open in.

use ticketd_core::{
    Chat, ChatObservation, ChatOwner, ChatPlannedWrite, ChatPlannedWriteKind, ChatToolState,
    ChatWriteCredit, NewChat, Status, TicketPatch, Workspace,
};

struct Setup {
    dir: tempfile::TempDir,
    host: Workspace,
    chat: Chat,
    reference: String,
}

impl Setup {
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("workspace.sqlite3")
    }

    /// A `ticketd` process the Chat's harness started: its own connection, acting for the Chat,
    /// with the harness's per-call key in the environment when it has one.
    #[allow(clippy::unwrap_used)]
    fn cli(&self, call: Option<&str>) -> Workspace {
        let mut cli = Workspace::open(self.path()).unwrap();
        cli.act_for_chat_call(&self.chat.id, call).unwrap();
        cli
    }

    #[allow(clippy::unwrap_used)]
    fn observe(&mut self, observations: Vec<ChatObservation>) {
        self.host
            .record_chat_observations(&self.chat.id, observations)
            .unwrap();
    }

    #[allow(clippy::unwrap_used)]
    fn activity(&self, call: Option<&str>, brief: &str) -> String {
        self.cli(call)
            .add_activity(&self.reference, brief, Some("claude-code"))
            .unwrap()
            .id
    }

    #[allow(clippy::unwrap_used)]
    fn move_to(&self, call: Option<&str>, status: Status) {
        self.cli(call)
            .change_ticket(
                &self.reference,
                TicketPatch {
                    status: Some(status),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    #[allow(clippy::unwrap_used)]
    fn credits(&self) -> ticketd_core::TicketWriteCredits {
        self.host.ticket_write_credits(&self.reference).unwrap()
    }

    fn credit_of(&self, activity: &str) -> Option<ChatWriteCredit> {
        self.credits().activities.get(activity).cloned()
    }
}

#[allow(clippy::unwrap_used)]
fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let chat = host
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "claude-code".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    let reference = host.create_ticket("Reset email").unwrap().reference;
    Setup {
        dir,
        host,
        chat,
        reference,
    }
}

fn sub_agent(id: &str) -> ChatOwner {
    ChatOwner::SubAgent {
        native_id: id.into(),
    }
}

fn start_sub_agent(id: &str) -> ChatObservation {
    ChatObservation::SubAgentStarted {
        native_id: id.into(),
        parent: None,
        tool_id: None,
        turn_id: None,
        native_run_id: None,
        background: true,
        payload: r#"{"description":"Check limiter test coverage"}"#.into(),
    }
}

fn shell(tool: &str, owner: ChatOwner, state: ChatToolState) -> ChatObservation {
    ChatObservation::Tool {
        tool_id: tool.into(),
        turn_id: None,
        owner,
        name: "Bash".into(),
        input: String::new(),
        state,
        output: None,
    }
}

fn window(tool: &str, writes: Vec<ChatPlannedWrite>) -> ChatObservation {
    ChatObservation::ShellStep {
        tool_id: tool.into(),
        writes,
    }
}

fn plans(kind: ChatPlannedWriteKind, reference: &str) -> ChatPlannedWrite {
    ChatPlannedWrite {
        kind,
        references: vec![reference.into()],
    }
}

fn credited(chat: &Chat, sub_agent: Option<&str>) -> Option<ChatWriteCredit> {
    Some(ChatWriteCredit {
        chat_id: chat.id.clone(),
        sub_agent: sub_agent.map(str::to_owned),
    })
}

/// Opens a shell Step of `owner` (running), with the commands it names.
fn open(setup: &mut Setup, tool: &str, owner: ChatOwner, writes: Vec<ChatPlannedWrite>) {
    setup.observe(vec![
        shell(tool, owner, ChatToolState::Running),
        window(tool, writes),
    ]);
}

fn close(setup: &mut Setup, tool: &str, owner: ChatOwner) {
    setup.observe(vec![shell(tool, owner, ChatToolState::Completed)]);
}

#[test]
fn a_write_inside_one_sub_agents_shell_window_is_credited_to_it_without_a_turn() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    let activity = setup.activity(None, "Added a case for a request with no key.");
    close(&mut setup, "run-1:bash-1", sub_agent("sa-tests"));

    assert_eq!(
        setup.credit_of(&activity),
        credited(&setup.chat, Some("sa-tests"))
    );
}

#[test]
fn a_status_change_is_credited_like_an_activity() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    setup.move_to(None, Status::InProgress);
    close(&mut setup, "run-1:bash-1", sub_agent("sa-tests"));

    let credits = setup.credits();
    assert_eq!(credits.statuses.len(), 1);
    assert_eq!(
        credits.statuses.values().next().cloned(),
        credited(&setup.chat, Some("sa-tests"))
    );
}

#[test]
fn writes_outside_every_window_stay_with_the_chat() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    close(&mut setup, "run-1:bash-1", sub_agent("sa-tests"));
    let after = setup.activity(None, "After the Step ended.");

    assert_eq!(setup.credit_of(&after), credited(&setup.chat, None));
}

#[test]
fn a_main_agent_step_credits_the_chat_without_a_sub_agent() {
    let mut setup = setup();
    open(&mut setup, "run-1:bash-1", ChatOwner::Main, vec![]);
    let activity = setup.activity(None, "From the main agent.");
    close(&mut setup, "run-1:bash-1", ChatOwner::Main);

    assert_eq!(setup.credit_of(&activity), credited(&setup.chat, None));
}

#[test]
fn overlapping_windows_credit_the_chat_with_the_sub_agent_unknown() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-a"), start_sub_agent("sa-b")]);
    open(&mut setup, "run-1:bash-a", sub_agent("sa-a"), vec![]);
    open(&mut setup, "run-1:bash-b", sub_agent("sa-b"), vec![]);
    let activity = setup.activity(None, "Either could have written this.");
    close(&mut setup, "run-1:bash-a", sub_agent("sa-a"));
    close(&mut setup, "run-1:bash-b", sub_agent("sa-b"));

    assert_eq!(setup.credit_of(&activity), credited(&setup.chat, None));
}

#[test]
fn overlapping_windows_fall_back_to_the_one_parsed_call_that_matches() {
    let mut setup = setup();
    let reference = setup.reference.clone();
    setup.observe(vec![start_sub_agent("sa-a"), start_sub_agent("sa-b")]);
    open(
        &mut setup,
        "run-1:bash-a",
        sub_agent("sa-a"),
        vec![plans(ChatPlannedWriteKind::Status, &reference)],
    );
    open(
        &mut setup,
        "run-1:bash-b",
        sub_agent("sa-b"),
        vec![plans(ChatPlannedWriteKind::Activity, &reference)],
    );
    let activity = setup.activity(None, "Only sa-b names an Activity.");
    setup.move_to(None, Status::InProgress);
    close(&mut setup, "run-1:bash-a", sub_agent("sa-a"));
    close(&mut setup, "run-1:bash-b", sub_agent("sa-b"));

    let credits = setup.credits();
    assert_eq!(
        credits.activities.get(&activity).cloned(),
        credited(&setup.chat, Some("sa-b"))
    );
    assert_eq!(
        credits.statuses.values().next().cloned(),
        credited(&setup.chat, Some("sa-a"))
    );
}

#[test]
fn two_parsed_calls_that_both_match_stay_unknown() {
    let mut setup = setup();
    let reference = setup.reference.clone();
    setup.observe(vec![start_sub_agent("sa-a"), start_sub_agent("sa-b")]);
    for (tool, owner) in [("run-1:bash-a", "sa-a"), ("run-1:bash-b", "sa-b")] {
        open(
            &mut setup,
            tool,
            sub_agent(owner),
            vec![plans(ChatPlannedWriteKind::Activity, &reference)],
        );
    }
    let activity = setup.activity(None, "Both name an Activity.");

    assert_eq!(setup.credit_of(&activity), credited(&setup.chat, None));
}

#[test]
fn a_parsed_call_for_another_ticket_does_not_match() {
    let mut setup = setup();
    let other = setup.host.create_ticket("Other").unwrap().reference;
    setup.observe(vec![start_sub_agent("sa-a"), start_sub_agent("sa-b")]);
    open(
        &mut setup,
        "run-1:bash-a",
        sub_agent("sa-a"),
        vec![plans(ChatPlannedWriteKind::Activity, &other)],
    );
    open(&mut setup, "run-1:bash-b", sub_agent("sa-b"), vec![]);
    let activity = setup.activity(None, "Not the ticket sa-a names.");

    assert_eq!(setup.credit_of(&activity), credited(&setup.chat, None));
}

#[test]
fn a_call_key_credits_exactly_even_while_windows_overlap() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("child-1")]);
    // Codex: the Step's native item ID is the key the CLI is given.
    open(&mut setup, "run-1:exec-main", ChatOwner::Main, vec![]);
    open(&mut setup, "run-1:exec-child", sub_agent("child-1"), vec![]);
    let by_child = setup.activity(Some("exec-child"), "From the child.");
    let by_main = setup.activity(Some("exec-main"), "From the main agent.");

    assert_eq!(
        setup.credit_of(&by_child),
        credited(&setup.chat, Some("child-1"))
    );
    assert_eq!(setup.credit_of(&by_main), credited(&setup.chat, None));
}

#[test]
fn a_call_key_no_step_has_is_never_guessed_from_a_window() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("child-1")]);
    open(&mut setup, "run-1:exec-child", sub_agent("child-1"), vec![]);
    let activity = setup.activity(Some("exec-somewhere-else"), "Whose Step is that?");

    assert_eq!(setup.credit_of(&activity), credited(&setup.chat, None));
}

#[test]
fn a_step_lost_with_the_harness_closes_its_window() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    setup
        .host
        .mark_chat_runtime_lost(&setup.chat.id, None, "The harness quit.", "contact_lost")
        .unwrap();
    let later = setup.activity(None, "Written by something else, later.");

    assert_eq!(setup.credit_of(&later), credited(&setup.chat, None));
}

#[test]
fn a_writing_agent_is_running_while_its_sub_agent_runs() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    setup.activity(None, "Progress.");
    close(&mut setup, "run-1:bash-1", sub_agent("sa-tests"));

    let agents = setup.host.ticket_writing_agents(&setup.reference).unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].chat_id, setup.chat.id);
    assert_eq!(agents[0].sub_agent.as_deref(), Some("sa-tests"));
    assert!(agents[0].running);

    setup.observe(vec![ChatObservation::SubAgentEnded {
        native_id: "sa-tests".into(),
        native_run_id: None,
        state: ticketd_core::ChatSubAgentState::Completed,
        stopped_by: None,
        stop_reason: None,
        detail: None,
    }]);
    let agents = setup.host.ticket_writing_agents(&setup.reference).unwrap();
    assert!(!agents[0].running);
}

#[test]
fn evidence_is_not_credited() {
    let mut setup = setup();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    setup
        .cli(None)
        .add_evidence(
            &setup.reference,
            ticketd_core::EvidenceInput {
                kind: ticketd_core::EvidenceKind::Branch,
                name: "branch".into(),
                value: "impl/x".into(),
                editing_agent: None,
            },
        )
        .unwrap();

    let credits = setup.credits();
    assert!(credits.activities.is_empty());
    assert!(credits.statuses.is_empty());
}

#[test]
fn tickets_with_a_running_writer_are_found_without_reading_every_ticket() {
    let mut setup = setup();
    let other = setup.host.create_ticket("Unrelated").unwrap();
    setup.observe(vec![start_sub_agent("sa-tests")]);
    open(&mut setup, "run-1:bash-1", sub_agent("sa-tests"), vec![]);
    setup.activity(None, "Progress.");
    close(&mut setup, "run-1:bash-1", sub_agent("sa-tests"));

    let running = setup.host.tickets_with_running_writers().unwrap();
    assert_eq!(
        running.iter().map(|t| t.1.as_str()).collect::<Vec<_>>(),
        vec![setup.reference.as_str()]
    );
    assert!(running.iter().all(|t| t.1 != other.reference));

    setup.observe(vec![ChatObservation::SubAgentEnded {
        native_id: "sa-tests".into(),
        native_run_id: None,
        state: ticketd_core::ChatSubAgentState::Completed,
        stopped_by: None,
        stop_reason: None,
        detail: None,
    }]);
    assert!(
        setup
            .host
            .tickets_with_running_writers()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_ticket_id_names_its_reference() {
    let setup = setup();
    let ticket = setup.host.show_ticket(&setup.reference).unwrap();
    assert_eq!(
        setup
            .host
            .ticket_reference_of(&ticket.id)
            .unwrap()
            .as_deref(),
        Some(setup.reference.as_str())
    );
    assert_eq!(setup.host.ticket_reference_of("nope").unwrap(), None);
}
