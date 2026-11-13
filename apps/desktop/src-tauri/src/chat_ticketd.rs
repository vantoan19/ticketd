//! A ticketd CLI call as the sentence a person would say for it ("Set T-MP4 to In
//! progress"), for the step row and the approval card. Only calls whose meaning is
//! plain from their words are told; any other call is shown as its command, and the
//! exact command is always one click away.
use serde::Serialize;

/// One ticketd call: a verb the view puts in the step's tense, and what follows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Call {
    /// `read`, `list`, `search`, `create`, `change`, `set`, `post`, `add`, `move`,
    /// `restore`, `tag` or `untag`.
    pub verb: &'static str,
    pub words: Vec<Word>,
}

/// A word of a call's sentence. A `code` word is a reference or a name in mono; a
/// `record` word names a Project, Document or Plan by id, which the view shows by its
/// title when it knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Word {
    pub text: String,
    pub code: bool,
    pub record: Option<&'static str>,
}

fn text(words: &str) -> Word {
    Word {
        text: words.to_owned(),
        code: false,
        record: None,
    }
}

fn code(words: &str) -> Word {
    Word {
        text: words.to_owned(),
        code: true,
        record: None,
    }
}

fn quoted(words: &str) -> Word {
    text(&format!("“{words}”"))
}

fn record(kind: &'static str, id: &str) -> Word {
    Word {
        text: id.to_owned(),
        code: false,
        record: Some(kind),
    }
}

/// The value given to `--name`, as `--name value` or `--name=value`.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    args.iter().enumerate().find_map(|(at, arg)| {
        if arg == name {
            args.get(at + 1).map(String::as_str)
        } else {
            arg.strip_prefix(&prefix)
        }
    })
}

fn call(verb: &'static str, words: Vec<Word>) -> Option<Call> {
    Some(Call { verb, words })
}

/// The sentence for one call's arguments, or `None` when its meaning is not plain.
fn one(args: &[String]) -> Option<Call> {
    // Positional words come before the first flag.
    let lead: Vec<&str> = args
        .iter()
        .take_while(|arg| !arg.starts_with('-'))
        .map(String::as_str)
        .collect();
    let rest = &args[lead.len()..];
    match lead.as_slice() {
        ["show", reference] => call("read", vec![code(reference)]),
        ["context", reference] => call("read", vec![text("the context of"), code(reference)]),
        ["history", reference] => call("read", vec![text("the history of"), code(reference)]),
        ["backlinks", reference] => call("read", vec![text("what links to"), code(reference)]),
        ["list"] => {
            let mut words = vec![text("tickets")];
            if let Some(project) = flag(rest, "--project") {
                words.extend([text("in Project"), record("project", project)]);
            }
            call("list", words)
        }
        ["search", query] => call("search", vec![text("tickets for"), quoted(query)]),
        ["create", title] => call("create", vec![text("the ticket"), quoted(title)]),
        ["change", reference] => {
            let status = flag(rest, "--status");
            // `--agent` names who made the change; it changes nothing itself.
            let more = rest.iter().any(|arg| {
                arg.starts_with("--")
                    && !["--status", "--agent"]
                        .iter()
                        .any(|known| arg == known || arg.starts_with(&format!("{known}=")))
            });
            match (status, more) {
                (Some(status), false) => {
                    call("set", vec![code(reference), text(&format!("to {status}"))])
                }
                (Some(status), true) => call(
                    "change",
                    vec![code(reference), text(&format!("and set it to {status}"))],
                ),
                (None, _) => call("change", vec![code(reference)]),
            }
        }
        ["trash", reference] => call("move", vec![code(reference), text("to Trash")]),
        ["restore", reference] => call("restore", vec![code(reference)]),
        ["add-tag", reference, tag] => call("tag", vec![code(reference), quoted(tag)]),
        ["remove-tag", reference, tag] => {
            call("untag", vec![code(reference), text("from"), quoted(tag)])
        }
        ["activity", "add", reference] => call("post", vec![text("an update on"), code(reference)]),
        ["activity", "list", reference] => {
            call("read", vec![text("the updates on"), code(reference)])
        }
        ["evidence", "add", reference] => call("add", vec![text("evidence to"), code(reference)]),
        ["evidence", "list", reference] => {
            call("read", vec![text("the evidence on"), code(reference)])
        }
        ["project", "show", id] => call("read", vec![text("Project"), record("project", id)]),
        ["project", "list"] => call("list", vec![text("Projects")]),
        ["document", "show" | "read" | "open", id] => {
            call("read", vec![text("Document"), record("document", id)])
        }
        ["document", "create"] => match flag(rest, "--title") {
            Some(title) => call("create", vec![text("the Document"), quoted(title)]),
            None => call("create", vec![text("a Document")]),
        },
        ["document", "change", id] => {
            call("change", vec![text("Document"), record("document", id)])
        }
        ["document", "search", query] => call("search", vec![text("Documents for"), quoted(query)]),
        ["document", "recent"] => call("list", vec![text("recent Documents")]),
        ["plan", "show" | "context", id] => call("read", vec![text("Plan"), record("plan", id)]),
        ["plan", "list"] => call("list", vec![text("Plans")]),
        ["skills", "get"] => call("read", vec![text("the ticketd guide")]),
        ["skills", "get", name] => {
            call("read", vec![text("the ticketd"), code(name), text("guide")])
        }
        ["skills", "list"] => call("list", vec![text("ticketd guides")]),
        _ => None,
    }
}

/// Every call as a sentence, or `None` when any one of them is not plain: then the
/// command is shown instead, so nothing that runs goes unsaid.
pub fn sentences(calls: &[Vec<String>]) -> Option<Vec<Call>> {
    calls.iter().map(|args| one(args)).collect()
}

#[cfg(test)]
mod tests {
    use super::{Call, sentences};

    /// The words as the view joins them, with the verb in its plain form.
    fn said(command: &[&str]) -> Option<String> {
        let args: Vec<String> = command.iter().map(|arg| (*arg).to_owned()).collect();
        sentences(&[args]).map(|calls: Vec<Call>| {
            calls
                .iter()
                .map(|call| {
                    let words: Vec<&str> =
                        call.words.iter().map(|word| word.text.as_str()).collect();
                    format!("{} {}", call.verb, words.join(" "))
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
    }

    /// LIVE-4: the common calls read as sentences; anything else is not guessed.
    #[test]
    fn common_ticketd_calls_read_as_sentences() {
        let cases: &[(&[&str], Option<&str>)] = &[
            (&["show", "T-MP4"], Some("read T-MP4")),
            (
                &[
                    "change",
                    "T-MP4",
                    "--status",
                    "In progress",
                    "--agent",
                    "claude-code",
                ],
                Some("set T-MP4 to In progress"),
            ),
            (
                &["change", "T-MP4", "--title", "New", "--status=Done"],
                Some("change T-MP4 and set it to Done"),
            ),
            (
                &["activity", "add", "T-MP4", "--brief", "Started"],
                Some("post an update on T-MP4"),
            ),
            (&["project", "show", "f33f"], Some("read Project f33f")),
            (&["document", "show", "d1"], Some("read Document d1")),
            (
                &["skills", "get", "chat"],
                Some("read the ticketd chat guide"),
            ),
            (
                &["list", "--project", "f33f"],
                Some("list tickets in Project f33f"),
            ),
            (&["skills", "install", "--harness", "codex"], None),
            (&["batch", "-"], None),
            (&["show"], None),
        ];
        for (command, expected) in cases {
            assert_eq!(said(command).as_deref(), *expected, "{command:?}");
        }
        let words =
            &sentences(&[vec!["project".into(), "show".into(), "f33f".into()]]).unwrap()[0].words;
        assert_eq!(words[1].record, Some("project"));
    }
}
