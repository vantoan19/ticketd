//! What a shell command did, read from its text: one table for every harness, so a
//! Chat says "Read `a.ts`" or "Searched for `x` in `src`" instead of "Ran" for
//! nearly everything. Only a confident reading is told; anything else stays a
//! command ("run") shown as it was written.

/// The kinds of step a command can be told as. Create, web and other come from
/// harness tools, never from a command's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Search,
    Edit,
    Delete,
    Run,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Search => "search",
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::Run => "run",
        }
    }
}

/// A wording within a kind: a read that lists folders, a web step that fetches a page,
/// a command that runs a script given on its input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    List,
    Fetch,
    Script,
}

impl Variant {
    pub fn name(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Fetch => "fetch",
            Self::Script => "script",
        }
    }
}

/// A path, pattern, query or page a step acted on, exactly as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub text: String,
    /// The lines read, first and last.
    pub lines: Option<(u32, u32)>,
    /// Where a search looked.
    pub scope: Option<String>,
}

impl Target {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            lines: None,
            scope: None,
        }
    }
}

/// A command as a step: its kind, what it acted on, and the command without its
/// wrappers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    pub kind: Kind,
    pub variant: Option<Variant>,
    pub targets: Vec<Target>,
    /// Where the command ran, from a leading `cd`, as written.
    pub folder: Option<String>,
    /// The command without shell wrappers and leading setup such as `cd`.
    pub command: String,
}

/// Reads a command line as a step.
pub fn shell(command: &str) -> Shell {
    let script = unwrap(command, 2);
    let run = |text: &str| Shell {
        kind: Kind::Run,
        variant: None,
        targets: Vec::new(),
        folder: None,
        command: text.trim().to_owned(),
    };
    let Ok(tokens) = lex(&script) else {
        return run(&script);
    };
    let segments = segments(tokens);
    let mut folder: Vec<String> = Vec::new();
    let mut kept: Vec<(usize, Effect)> = Vec::new();
    for segment in &segments {
        match pipeline(&segment.stages) {
            Effect::Setup { folder: Some(path) } => folder.push(path),
            Effect::Setup { folder: None } | Effect::Print => {}
            effect => kept.push((segment.start, effect)),
        }
    }
    let folder = (!folder.is_empty()).then(|| folder.join("/"));
    let Some(&(start, _)) = kept.first() else {
        return run(&script);
    };
    let command = script.get(start..).unwrap_or(&script).trim().to_owned();
    let (kind, variant, targets) = chain(kept.into_iter().map(|(_, effect)| effect).collect());
    Shell {
        kind,
        variant,
        targets,
        folder,
        command,
    }
}

// -- wrappers ----------------------------------------------------------------------

/// A command without the shell wrappers around it (`zsh -lc '…'`); any other text
/// as it is.
pub fn unwrapped(command: &str) -> String {
    unwrap(command, 2)
}

/// Removes up to `depth` shell wrappers (`zsh -lc '…'`, `powershell -Command "…"`,
/// `cmd /c …`). A wrapper whose quotes do not balance stays as it is.
fn unwrap(command: &str, depth: usize) -> String {
    let mut text = command.trim().to_owned();
    for _ in 0..depth {
        let Some(inner) = inner_script(&text) else {
            break;
        };
        text = inner;
    }
    text
}

fn inner_script(text: &str) -> Option<String> {
    let tokens = lex(text).ok()?;
    let words: Vec<&Word> = tokens
        .iter()
        .map(|token| match token {
            Token::Word(word) => Some(word),
            _ => None,
        })
        .collect::<Option<_>>()?;
    let (program, rest) = words.split_first()?;
    let name = program_name(&program.text);
    let script = match name.as_str() {
        "zsh" | "bash" | "sh" => match rest {
            [flag, script] if matches!(flag.text.as_str(), "-c" | "-lc") => script,
            [login, flag, script] if login.text == "-l" && flag.text == "-c" => script,
            _ => return None,
        },
        "powershell" | "pwsh" => {
            let at = rest.iter().position(|word| {
                matches!(word.text.to_ascii_lowercase().as_str(), "-command" | "-c")
            })?;
            let leading_ok = rest[..at].iter().all(|word| word.text.starts_with('-'));
            match &rest[at + 1..] {
                [script] if leading_ok => script,
                _ => return None,
            }
        }
        "cmd" => match rest {
            [flag, script] if flag.text.eq_ignore_ascii_case("/c") => script,
            _ => return None,
        },
        _ => return None,
    };
    Some(script.text.clone())
}

/// A program's name without its folder, `.exe` or letter case.
fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let base = base.to_ascii_lowercase();
    base.strip_suffix(".exe").map(str::to_owned).unwrap_or(base)
}

// -- lexing ------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Word {
    /// The word with its quotes removed.
    text: String,
    /// Nothing in it is expanded when the command runs.
    literal: bool,
    start: usize,
}

#[derive(Debug, Clone)]
enum Token {
    Word(Word),
    /// `&&`, `||`, `;`, `&` or a newline: the end of one command of a chain.
    Separator,
    Pipe,
    /// A redirect operator, such as `>`, `2>`, `>>` or `<<`; its target follows.
    Redirect(String),
}

#[derive(Debug)]
struct Unbalanced;

/// The word being read, started at `at` when there is none.
fn current(word: &mut Option<Word>, at: usize) -> &mut Word {
    word.get_or_insert_with(|| Word {
        text: String::new(),
        literal: true,
        start: at,
    })
}

fn lex(text: &str) -> Result<Vec<Token>, Unbalanced> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut tokens = Vec::new();
    let mut word: Option<Word> = None;
    let mut heredocs: Vec<(String, bool)> = Vec::new();
    let mut expect_heredoc = false;
    let mut i = 0;
    let end_word = |word: &mut Option<Word>,
                    tokens: &mut Vec<Token>,
                    heredoc: &mut bool,
                    heredocs: &mut Vec<(String, bool)>| {
        if let Some(done) = word.take() {
            if *heredoc {
                heredocs.push((done.text.clone(), false));
                *heredoc = false;
            }
            tokens.push(Token::Word(done));
        }
    };
    while i < chars.len() {
        let (at, c) = chars[i];
        let next = chars.get(i + 1).map(|(_, c)| *c);
        match c {
            ' ' | '\t' | '\r' => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs)
            }
            '\\' if next == Some('\n') => i += 1,
            '\n' => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Separator);
                // Heredoc bodies are input, never commands: skip to their delimiters.
                for (delimiter, _) in heredocs.drain(..) {
                    let mut line = String::new();
                    i += 1;
                    loop {
                        match chars.get(i) {
                            None => break,
                            Some((_, '\n')) => {
                                if line.trim() == delimiter {
                                    break;
                                }
                                line.clear();
                            }
                            Some((_, c)) => line.push(*c),
                        }
                        i += 1;
                    }
                    if line.trim() != delimiter {
                        i = chars.len();
                    }
                }
            }
            '\'' => {
                let word = current(&mut word, at);
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(Unbalanced),
                        Some((_, '\'')) => break,
                        Some((_, c)) => word.text.push(*c),
                    }
                    i += 1;
                }
            }
            '"' => {
                let word = current(&mut word, at);
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(Unbalanced),
                        Some((_, '"')) => break,
                        Some((_, '\\')) => {
                            i += 1;
                            match chars.get(i) {
                                None => return Err(Unbalanced),
                                Some((_, c @ ('"' | '\\' | '$' | '`'))) => word.text.push(*c),
                                Some((_, c)) => {
                                    word.text.push('\\');
                                    word.text.push(*c);
                                }
                            }
                        }
                        Some((_, c @ ('$' | '`'))) => {
                            word.literal = false;
                            word.text.push(*c);
                        }
                        Some((_, c)) => word.text.push(*c),
                    }
                    i += 1;
                }
            }
            '\\' => {
                i += 1;
                match chars.get(i) {
                    Some((_, c)) => current(&mut word, at).text.push(*c),
                    None => return Err(Unbalanced),
                }
            }
            '$' | '`' => {
                let word = current(&mut word, at);
                word.literal = false;
                word.text.push(c);
            }
            '#' if word.is_none() => {
                while i + 1 < chars.len() && chars[i + 1].1 != '\n' {
                    i += 1;
                }
            }
            ';' => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Separator);
            }
            '&' if next == Some('&') => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Separator);
                i += 1;
            }
            '&' if next == Some('>') => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                i += 1;
                let append = chars.get(i + 1).map(|(_, c)| *c) == Some('>');
                if append {
                    i += 1;
                }
                tokens.push(Token::Redirect(
                    if append { "&>>" } else { "&>" }.to_owned(),
                ));
            }
            '&' => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Separator);
            }
            '|' if next == Some('|') => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Separator);
                i += 1;
            }
            '|' => {
                end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                tokens.push(Token::Pipe);
            }
            '>' | '<' => {
                // A number right before the operator is the stream it redirects.
                let stream = word.as_ref().is_some_and(|w| {
                    !w.text.is_empty() && w.text.chars().all(|c| c.is_ascii_digit())
                });
                let fd = if stream {
                    word.take().map(|w| w.text)
                } else {
                    end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
                    None
                };
                let mut op = fd.unwrap_or_default();
                op.push(c);
                while let Some((_, more @ ('>' | '<' | '&' | '|' | '-'))) = chars.get(i + 1) {
                    if *more == '-' && !op.ends_with("<<") {
                        break;
                    }
                    op.push(*more);
                    i += 1;
                }
                if op.ends_with("<<") || op.ends_with("<<-") {
                    expect_heredoc = true;
                }
                tokens.push(Token::Redirect(op));
            }
            c => current(&mut word, at).text.push(c),
        }
        i += 1;
    }
    end_word(&mut word, &mut tokens, &mut expect_heredoc, &mut heredocs);
    Ok(tokens)
}

// -- structure ---------------------------------------------------------------------

#[derive(Debug, Default)]
struct Simple {
    words: Vec<Word>,
    /// Redirect operators and their targets.
    redirects: Vec<(String, Option<Word>)>,
}

#[derive(Debug)]
struct Segment {
    /// Where the segment begins in the script.
    start: usize,
    stages: Vec<Simple>,
}

fn segments(tokens: Vec<Token>) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut stages: Vec<Simple> = vec![Simple::default()];
    let mut start: Option<usize> = None;
    let mut pending: Option<String> = None;
    let mut close = |stages: &mut Vec<Simple>, start: &mut Option<usize>| {
        let taken = std::mem::replace(stages, vec![Simple::default()]);
        if let Some(at) = start.take()
            && taken
                .iter()
                .any(|stage| !stage.words.is_empty() || !stage.redirects.is_empty())
        {
            segments.push(Segment {
                start: at,
                stages: taken,
            });
        }
    };
    for token in tokens {
        match token {
            Token::Word(word) => {
                start.get_or_insert(word.start);
                if let Some(stage) = stages.last_mut() {
                    match pending.take() {
                        Some(op) => stage.redirects.push((op, Some(word))),
                        None => stage.words.push(word),
                    }
                }
            }
            Token::Redirect(op) => {
                if let (Some(op), Some(stage)) = (pending.replace(op), stages.last_mut()) {
                    stage.redirects.push((op, None));
                }
            }
            Token::Pipe => stages.push(Simple::default()),
            Token::Separator => close(&mut stages, &mut start),
        }
    }
    close(&mut stages, &mut start);
    segments
}

// -- effects -----------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Effect {
    /// `cd`, `export`, `mkdir`, …: not what the command is for.
    Setup {
        folder: Option<String>,
    },
    /// Prints its arguments or passes its input through.
    Print,
    Read {
        targets: Vec<Target>,
        list: bool,
    },
    Search {
        targets: Vec<Target>,
    },
    Edit {
        targets: Vec<Target>,
    },
    Delete {
        targets: Vec<Target>,
    },
    /// An interpreter running a script given on its input.
    Script {
        program: String,
    },
    /// Not recognised, or not literal: its effects are unknown.
    Unknown,
}

/// A pipeline reads as its first command that does more than print. A later stage
/// that writes, or that is not recognised, makes it a command.
fn pipeline(stages: &[Simple]) -> Effect {
    let effects: Vec<Effect> = stages.iter().map(simple).collect();
    let Some(main) = effects.iter().position(|effect| *effect != Effect::Print) else {
        return Effect::Print;
    };
    let mut effect = effects[main].clone();
    for (later, stage) in effects[main + 1..].iter().zip(&stages[main + 1..]) {
        match later {
            Effect::Print | Effect::Read { .. } | Effect::Search { .. } => {}
            _ => return Effect::Unknown,
        }
        // `nl -ba a.ts | sed -n '40,90p'` reads those lines of a.ts.
        if let (Effect::Read { targets, .. }, Some(lines)) = (&mut effect, sed_lines(stage))
            && let [target] = targets.as_mut_slice()
        {
            target.lines.get_or_insert(lines);
        }
    }
    if effects.len() > 1 && matches!(effect, Effect::Setup { .. }) {
        return Effect::Unknown;
    }
    effect
}

/// Words that redirect nothing worth telling: discarded output and joined streams.
fn quiet(op: &str, target: Option<&Word>) -> bool {
    op.ends_with('<')
        || op.contains("<<")
        || op.ends_with('&')
        || target
            .is_some_and(|word| word.text == "/dev/null" || word.text.eq_ignore_ascii_case("$null"))
}

fn simple(command: &Simple) -> Effect {
    let effect = program(command);
    if command
        .redirects
        .iter()
        .any(|(_, target)| target.as_ref().is_some_and(|word| !word.literal))
    {
        return Effect::Unknown;
    }
    let written: Vec<Target> = command
        .redirects
        .iter()
        .filter(|(op, target)| !quiet(op, target.as_ref()))
        .filter_map(|(_, target)| target.as_ref().map(|word| Target::new(&word.text)))
        .collect();
    if written.is_empty() {
        return effect;
    }
    // A redirect after a read or a print writes the file; after anything else the
    // command does more than one thing.
    match effect {
        Effect::Print | Effect::Read { .. } => Effect::Edit { targets: written },
        _ => Effect::Unknown,
    }
}

/// Flags of a program that take the next word as their value.
fn takes_value(program: &str, flag: &str) -> bool {
    let flags: &[&str] = match program {
        "head" | "tail" => &["-n", "-c"],
        "rg" | "ripgrep" => &[
            "-g",
            "--glob",
            "-t",
            "--type",
            "-T",
            "--type-not",
            "-e",
            "--regexp",
            "-f",
            "--file",
            "-m",
            "--max-count",
            "-A",
            "-B",
            "-C",
            "--context",
            "-j",
            "--threads",
            "-M",
            "--max-columns",
            "--iglob",
            "--max-depth",
            "-d",
            "--sort",
            "--sortr",
        ],
        "grep" | "egrep" | "fgrep" | "git-grep" => &[
            "-e",
            "--regexp",
            "-f",
            "--file",
            "-m",
            "--max-count",
            "-A",
            "-B",
            "-C",
            "--context",
            "--include",
            "--exclude",
            "--exclude-dir",
        ],
        "fd" | "fdfind" => &[
            "-e",
            "--extension",
            "-t",
            "--type",
            "-d",
            "--max-depth",
            "-E",
            "--exclude",
        ],
        "sed" => &["-e", "--expression", "-f", "--file"],
        "tree" => &["-L", "-I", "-P"],
        _ => &[],
    };
    flags.contains(&flag)
}

/// Positional words, skipping flags and the values flags take.
fn positional<'a>(program: &str, words: &'a [Word]) -> Vec<&'a Word> {
    let mut out = Vec::new();
    let mut skip = false;
    let mut flags_done = false;
    for word in words {
        if skip {
            skip = false;
            continue;
        }
        if !flags_done && word.text == "--" {
            flags_done = true;
            continue;
        }
        if !flags_done && word.text.starts_with('-') && word.text.len() > 1 {
            skip = takes_value(program, &word.text);
            continue;
        }
        out.push(word);
    }
    out
}

/// The values flags were given as the next word: `-e x`, or PowerShell's `-Path x`.
fn flag_values<'a>(words: &'a [Word], names: &[&str]) -> Vec<&'a Word> {
    let mut out = Vec::new();
    let mut iter = words.iter();
    while let Some(word) = iter.next() {
        if names
            .iter()
            .any(|name| word.text.eq_ignore_ascii_case(name))
            && let Some(value) = iter.next()
        {
            out.push(value);
        }
    }
    out
}

fn targets(words: &[&Word]) -> Vec<Target> {
    words.iter().map(|word| Target::new(&word.text)).collect()
}

/// The lines `sed -n 'a,bp'` prints.
fn sed_lines(command: &Simple) -> Option<(u32, u32)> {
    let words = &command.words;
    if words
        .first()
        .map(|word| program_name(&word.text))
        .as_deref()
        != Some("sed")
        || !words.iter().any(|word| word.text == "-n")
    {
        return None;
    }
    let script = positional("sed", &words[1..]).first()?.text.clone();
    let range = script.strip_suffix('p')?;
    let (from, to) = range.split_once(',').unwrap_or((range, range));
    Some((from.parse().ok()?, to.parse().ok()?))
}

/// The effect of one command by its program, looking through `sudo`, `env`,
/// `timeout` and leading variable assignments.
fn program(command: &Simple) -> Effect {
    let mut words: &[Word] = &command.words;
    loop {
        let Some((first, rest)) = words.split_first() else {
            return Effect::Print;
        };
        let assignment = first.text.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        let name = program_name(&first.text);
        if assignment {
            words = rest;
        } else if name == "sudo" || name == "env" {
            let skip = rest
                .iter()
                .take_while(|word| word.text.starts_with('-') || word.text.contains('='))
                .count();
            words = &rest[skip..];
        } else if name == "timeout" {
            let skip = rest
                .iter()
                .take_while(|word| word.text.starts_with('-'))
                .count();
            words = rest.get(skip + 1..).unwrap_or(&[]);
        } else {
            break;
        }
    }
    let Some((first, args)) = words.split_first() else {
        return Effect::Print;
    };
    let name = program_name(&first.text);
    let literal = words.iter().all(|word| word.literal);
    let setup = |folder| Effect::Setup { folder };
    match name.as_str() {
        "cd" | "pushd" | "set-location" | "sl" if literal => setup(
            positional(&name, args)
                .first()
                .map(|word| word.text.clone()),
        ),
        "export" | "source" | "." | "mkdir" | "set" | "setopt" | "true" => setup(None),
        _ if !literal => Effect::Unknown,
        "echo" | "printf" | "write-output" | "write-host" => Effect::Print,
        "cat" | "head" | "tail" | "nl" | "wc" | "bat" | "less" | "more" | "get-content" | "gc" => {
            let files = positional(&name, args);
            if files.is_empty() {
                Effect::Print
            } else {
                Effect::Read {
                    targets: targets(&files),
                    list: false,
                }
            }
        }
        "sed" => sed(args),
        "perl" => {
            let in_place = args.iter().any(|word| {
                word.text.starts_with('-')
                    && !word.text.starts_with("--")
                    && word.text.contains('i')
            });
            let files = positional(&name, args);
            match (in_place, files.split_first()) {
                // The first positional is the program when no `-e` gave it.
                (true, Some((_, files))) if !files.is_empty() => Effect::Edit {
                    targets: targets(files),
                },
                _ => Effect::Unknown,
            }
        }
        "tee" => {
            let files = positional(&name, args);
            if files.is_empty() {
                Effect::Print
            } else {
                Effect::Edit {
                    targets: targets(&files),
                }
            }
        }
        "set-content" | "out-file" | "add-content" | "sc" | "ac" => {
            let mut files = flag_values(args, &["-path", "-filepath", "-literalpath"]);
            if files.is_empty() {
                files = args
                    .iter()
                    .take(1)
                    .filter(|word| !word.text.starts_with('-'))
                    .collect();
            }
            if files.is_empty() {
                Effect::Unknown
            } else {
                Effect::Edit {
                    targets: targets(&files),
                }
            }
        }
        "ls" | "tree" | "dir" | "exa" | "eza" | "get-childitem" | "gci" => {
            let mut folders = flag_values(args, &["-path", "-literalpath"]);
            if folders.is_empty() && !name.starts_with("get-") && name != "gci" {
                folders = positional(&name, args);
            } else if folders.is_empty() {
                folders = args
                    .iter()
                    .take(1)
                    .filter(|word| !word.text.starts_with('-'))
                    .collect();
            }
            Effect::Read {
                targets: targets(&folders),
                list: true,
            }
        }
        "find" => find(args),
        "rg" | "ripgrep" => rg(args),
        "grep" | "egrep" | "fgrep" => grep(&name, args),
        "git" => match args.split_first() {
            Some((sub, rest)) if sub.text == "grep" => grep("git-grep", rest),
            Some((sub, rest)) if sub.text == "rm" => Effect::Delete {
                targets: targets(&positional("git-rm", rest)),
            },
            _ => Effect::Unknown,
        },
        "fd" | "fdfind" => {
            let words = positional(&name, args);
            match words.split_first() {
                Some((pattern, scope)) => Effect::Search {
                    targets: vec![Target {
                        scope: scope.first().map(|word| word.text.clone()),
                        ..Target::new(&pattern.text)
                    }],
                },
                None => Effect::Read {
                    targets: Vec::new(),
                    list: true,
                },
            }
        }
        "select-string" | "sls" => {
            let pattern = flag_values(args, &["-pattern"]);
            let path = flag_values(args, &["-path", "-literalpath"]);
            let rest: Vec<&Word> = args
                .iter()
                .filter(|word| !word.text.starts_with('-'))
                .collect();
            let pattern = pattern.first().or(rest.first());
            match pattern {
                Some(pattern) => Effect::Search {
                    targets: vec![Target {
                        scope: path.first().or(rest.get(1)).map(|word| word.text.clone()),
                        ..Target::new(&pattern.text)
                    }],
                },
                None => Effect::Unknown,
            }
        }
        "rm" | "rmdir" | "unlink" | "del" | "erase" | "rd" | "remove-item" | "ri" => {
            let mut files = flag_values(args, &["-path", "-literalpath"]);
            if files.is_empty() {
                files = positional(&name, args);
            }
            if files.is_empty() {
                Effect::Unknown
            } else {
                Effect::Delete {
                    targets: targets(&files),
                }
            }
        }
        "python" | "python3" | "node" | "ruby" | "bash" | "sh" | "zsh" | "deno" | "bun"
            if args.iter().all(|word| word.text == "-")
                && command.redirects.iter().any(|(op, _)| op.contains("<<")) =>
        {
            Effect::Script { program: name }
        }
        _ => Effect::Unknown,
    }
}

fn sed(args: &[Word]) -> Effect {
    let mut in_place = false;
    let mut print_only = false;
    let mut script_given = false;
    let mut files = Vec::new();
    let mut iter = args.iter().peekable();
    while let Some(word) = iter.next() {
        let text = word.text.as_str();
        if text == "-i" || text == "--in-place" {
            in_place = true;
            // BSD sed takes the backup suffix as the next word, often empty.
            if iter.peek().is_some_and(|next| next.text.is_empty()) {
                iter.next();
            }
        } else if text.starts_with("-i") || text.starts_with("--in-place=") {
            in_place = true;
        } else if text == "-n" || text == "--quiet" {
            print_only = true;
        } else if text == "-e" || text == "--expression" || text == "-f" {
            script_given = true;
            iter.next();
        } else if text.starts_with('-') && text.len() > 1 {
            // -E, -r, -s, -u, or combined forms such as -ne.
            if text.contains('n') && !text.starts_with("--") {
                print_only = true;
            }
        } else if !script_given {
            script_given = true;
        } else {
            files.push(word);
        }
    }
    if in_place {
        return if files.is_empty() {
            Effect::Unknown
        } else {
            Effect::Edit {
                targets: targets(&files),
            }
        };
    }
    if files.is_empty() {
        return Effect::Print;
    }
    let mut targets = targets(&files);
    if print_only && let [target] = targets.as_mut_slice() {
        target.lines = sed_lines(&Simple {
            words: std::iter::once(Word {
                text: "sed".to_owned(),
                literal: true,
                start: 0,
            })
            .chain(args.iter().cloned())
            .collect(),
            redirects: Vec::new(),
        });
    }
    Effect::Read {
        targets,
        list: false,
    }
}

fn find(args: &[Word]) -> Effect {
    let paths: Vec<&Word> = args
        .iter()
        .take_while(|word| !word.text.starts_with('-') && word.text != "(" && word.text != "!")
        .collect();
    let mut pattern = None;
    let mut delete = false;
    let mut iter = args.iter().skip(paths.len());
    while let Some(word) = iter.next() {
        match word.text.as_str() {
            "-name" | "-iname" | "-path" | "-ipath" | "-wholename" | "-regex" | "-iregex" => {
                pattern = iter.next().map(|word| word.text.clone());
            }
            "-delete" => delete = true,
            "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprint0" | "-fprintf"
            | "-fls" => return Effect::Unknown,
            _ => {}
        }
    }
    let scope = paths
        .iter()
        .map(|word| word.text.as_str())
        .find(|path| *path != ".")
        .map(str::to_owned);
    match (delete, pattern) {
        (true, Some(pattern)) => Effect::Delete {
            targets: vec![Target::new(match &scope {
                Some(scope) => format!("{}/{pattern}", scope.trim_end_matches('/')),
                None => pattern,
            })],
        },
        (true, None) if !paths.is_empty() => Effect::Delete {
            targets: targets(&paths),
        },
        (true, None) => Effect::Unknown,
        (false, Some(pattern)) => Effect::Search {
            targets: vec![Target {
                scope,
                ..Target::new(pattern)
            }],
        },
        (false, None) => Effect::Read {
            targets: targets(&paths),
            list: true,
        },
    }
}

fn rg(args: &[Word]) -> Effect {
    let globs = flag_values(args, &["-g", "--glob", "--iglob"]);
    let words = positional("rg", args);
    if args.iter().any(|word| word.text == "--files") {
        let scope = words.first().map(|word| word.text.clone());
        return match globs.first() {
            Some(glob) => Effect::Search {
                targets: vec![Target {
                    scope,
                    ..Target::new(&glob.text)
                }],
            },
            None => Effect::Read {
                targets: targets(&words),
                list: true,
            },
        };
    }
    search(flag_values(args, &["-e", "--regexp"]), words)
}

fn grep(program: &str, args: &[Word]) -> Effect {
    search(
        flag_values(args, &["-e", "--regexp"]),
        positional(program, args),
    )
}

/// A search for a pattern given by `-e` or as the first word, in the words after it.
fn search(given: Vec<&Word>, words: Vec<&Word>) -> Effect {
    let (patterns, scope): (Vec<&Word>, &[&Word]) = if given.is_empty() {
        match words.split_first() {
            Some((pattern, scope)) => (vec![*pattern], scope),
            None => return Effect::Unknown,
        }
    } else {
        (given, words.as_slice())
    };
    let scope = scope
        .iter()
        .map(|word| word.text.as_str())
        .find(|path| *path != ".")
        .map(str::to_owned);
    Effect::Search {
        targets: patterns
            .into_iter()
            .map(|pattern| Target {
                scope: scope.clone(),
                ..Target::new(&pattern.text)
            })
            .collect(),
    }
}

/// A chain takes its heaviest command: delete, then edit, read, search. An
/// unrecognised command is the heaviest, and two kinds of file change make a command.
fn chain(effects: Vec<Effect>) -> (Kind, Option<Variant>, Vec<Target>) {
    let run = (Kind::Run, None, Vec::new());
    if let [Effect::Script { program }] = effects.as_slice() {
        return (Kind::Run, Some(Variant::Script), vec![Target::new(program)]);
    }
    if effects.iter().any(|effect| {
        matches!(
            effect,
            Effect::Unknown | Effect::Script { .. } | Effect::Setup { .. } | Effect::Print
        )
    }) {
        return run;
    }
    let has = |kind: fn(&Effect) -> bool| effects.iter().any(kind);
    let deletes = has(|effect| matches!(effect, Effect::Delete { .. }));
    let edits = has(|effect| matches!(effect, Effect::Edit { .. }));
    if deletes && edits {
        return run;
    }
    let collect = |pick: fn(&Effect) -> Option<&Vec<Target>>| -> Vec<Target> {
        effects.iter().filter_map(pick).flatten().cloned().collect()
    };
    if deletes {
        return (
            Kind::Delete,
            None,
            collect(|effect| match effect {
                Effect::Delete { targets } => Some(targets),
                _ => None,
            }),
        );
    }
    if edits {
        return (
            Kind::Edit,
            None,
            collect(|effect| match effect {
                Effect::Edit { targets } => Some(targets),
                _ => None,
            }),
        );
    }
    let reads = collect(|effect| match effect {
        Effect::Read {
            targets,
            list: false,
        } => Some(targets),
        _ => None,
    });
    if !reads.is_empty() || has(|effect| matches!(effect, Effect::Read { list: false, .. })) {
        return (Kind::Read, None, reads);
    }
    if has(|effect| matches!(effect, Effect::Read { list: true, .. })) {
        return (
            Kind::Read,
            Some(Variant::List),
            collect(|effect| match effect {
                Effect::Read {
                    targets,
                    list: true,
                } => Some(targets),
                _ => None,
            }),
        );
    }
    (
        Kind::Search,
        None,
        collect(|effect| match effect {
            Effect::Search { targets } => Some(targets),
            _ => None,
        }),
    )
}

// -- ticketd ------------------------------------------------------------------------

/// The arguments of each ticketd CLI call a command makes, when that is all it does:
/// ticketd named by its path, by `ticketd` on PATH, or by a variable a setup step set
/// to it (`T=/…/ticketd; $T show T-1`). Leading `cd` and assignments are setup; a
/// pipe into a program that only shows the output (`| head`) is allowed. Anything
/// else — another command, a word that expands (`$(…)`), output written to a file —
/// makes it `None`, so the command is shown as it is and nothing that runs is hidden.
pub fn ticketd_calls(command: &str) -> Option<Vec<Vec<String>>> {
    let script = unwrap(command, 2);
    let tokens = lex(&script).ok()?;
    let mut names: Vec<String> = Vec::new();
    let mut calls = Vec::new();
    for segment in segments(tokens) {
        let (stage, viewers) = segment.stages.split_first()?;
        if !viewers.iter().all(only_shows) {
            return None;
        }
        if !stage
            .redirects
            .iter()
            .all(|(op, target)| quiet(op, target.as_ref()))
        {
            return None;
        }
        let mut words: &[Word] = &stage.words;
        if words.first().is_some_and(|word| word.text == "export") {
            words = &words[1..];
        }
        // Leading assignments: a variable set to ticketd names it from here on.
        let mut prefixed = false;
        while let Some((first, rest)) = words.split_first() {
            let Some((name, value)) = assignment(&first.text) else {
                break;
            };
            if !first.literal {
                return None;
            }
            if program_name(value) == "ticketd" {
                names.push(name.to_owned());
            }
            prefixed = true;
            words = rest;
        }
        let Some((program, args)) = words.split_first() else {
            continue;
        };
        if program.literal && program.text == "cd" && !prefixed {
            if args.iter().all(|word| word.literal) {
                continue;
            }
            return None;
        }
        let named = if program.literal {
            program_name(&program.text) == "ticketd"
        } else {
            let variable = program.text.strip_prefix('$')?;
            let variable = variable
                .strip_prefix('{')
                .and_then(|inner| inner.strip_suffix('}'))
                .unwrap_or(variable);
            names.iter().any(|name| name == variable)
        };
        if !named || !args.iter().all(|word| word.literal) {
            return None;
        }
        calls.push(args.iter().map(|word| word.text.clone()).collect());
    }
    (!calls.is_empty()).then_some(calls)
}

/// `NAME=value`: the name and the value.
fn assignment(text: &str) -> Option<(&str, &str)> {
    let (name, value) = text.split_once('=')?;
    let valid = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    valid.then_some((name, value))
}

/// A pipeline stage that only shows what it is given: `head`, `tail`, `jq`, `cat`.
fn only_shows(stage: &Simple) -> bool {
    let Some((program, args)) = stage.words.split_first() else {
        return false;
    };
    stage.redirects.iter().all(|(op, target)| quiet(op, target.as_ref()))
        && stage.words.iter().all(|word| word.literal)
        && matches!(
            program_name(&program.text).as_str(),
            "head" | "tail" | "jq" | "cat" | "less" | "more"
        )
        // `jq` reads files named after its filter; only stdin is shown.
        && positional(&program_name(&program.text), args).len() <= 1
}

/// A ticketd call as a person would type it: `ticketd show T-1`.
pub fn ticketd_command(args: &[String]) -> String {
    let mut out = String::from("ticketd");
    for arg in args {
        out.push(' ');
        let plain = !arg.is_empty()
            && arg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c));
        if plain {
            out.push_str(arg);
        } else {
            out.push('"');
            out.push_str(&arg.replace('\\', "\\\\").replace('"', "\\\""));
            out.push('"');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Kind, Shell, Variant, shell, ticketd_calls, ticketd_command};

    fn calls(command: &str) -> Option<Vec<String>> {
        ticketd_calls(command).map(|calls| calls.iter().map(|args| args.join(" ")).collect())
    }

    /// LIVE-4: ticketd reads as ticketd however it was named; anything more is not.
    #[test]
    fn ticketd_calls_are_found_however_ticketd_is_named() {
        let path = "/Users/me/ticketd/target/debug/ticketd";
        let one = |text: &str| Some(vec![text.to_owned()]);
        assert_eq!(
            calls(&format!("{path} project show f33f")),
            one("project show f33f")
        );
        assert_eq!(
            calls(&format!("T={path}\n$T skills get chat; \"$T\" show T-MP4")),
            Some(vec!["skills get chat".to_owned(), "show T-MP4".to_owned()])
        );
        assert_eq!(
            calls(&format!(
                r#"export T="{path}" && ${{T}} change T-MP4 --status "In progress" --agent claude-code"#
            )),
            one("change T-MP4 --status In progress --agent claude-code")
        );
        assert_eq!(
            calls("/bin/zsh -lc 'ticketd show T-1 2>&1 | head -40'"),
            one("show T-1")
        );
        assert_eq!(
            calls("$T show T-1"),
            None,
            "a variable never set to ticketd is not ticketd"
        );
        assert_eq!(
            calls(&format!(
                "T={path}; $T activity add T-1 --brief-file - <<'EOF'\nDone.\nEOF"
            )),
            one("activity add T-1 --brief-file -")
        );
        for other in [
            format!("{path} show T-1 && rm -rf dist"),
            format!(r#"{path} show "$(whoami)""#),
            format!("{path} export > out.json"),
            format!("{path} show T-1 | sh"),
            "ticketd-desktop show".to_owned(),
            "npm test".to_owned(),
        ] {
            assert_eq!(calls(&other), None, "{other}");
        }
        assert_eq!(
            ticketd_command(&[
                "change".into(),
                "T-1".into(),
                "--status".into(),
                "In progress".into()
            ]),
            r#"ticketd change T-1 --status "In progress""#
        );
    }

    /// The row a command reads as: its kind, variant, targets (with scope) and folder.
    fn row(command: &str) -> (Kind, Option<Variant>, Vec<String>, Option<String>) {
        let Shell {
            kind,
            variant,
            targets,
            folder,
            ..
        } = shell(command);
        let targets = targets
            .into_iter()
            .map(|target| match target.scope {
                Some(scope) => format!("{} in {scope}", target.text),
                None => target.text,
            })
            .collect();
        (kind, variant, targets, folder)
    }

    fn zsh(script: &str) -> String {
        format!("/bin/zsh -lc '{}'", script.replace('\'', r"'\''"))
    }

    /// The classification fixtures of the #366 design, one row each.
    #[test]
    fn commands_read_as_the_step_they_are() {
        use Kind::{Delete, Edit, Read, Run, Search};
        let none = None;
        let list = Some(Variant::List);
        type Case<'a> = (
            &'a str,
            Kind,
            Option<Variant>,
            &'a [&'a str],
            Option<&'a str>,
        );
        let cases: &[Case] = &[
            (
                "sed -n '1,120p' src/auth/limiter.ts",
                Read,
                none,
                &["src/auth/limiter.ts"],
                None,
            ),
            (
                "sed -n '1,80p' src/auth/login.ts && sed -n '1,60p' src/auth/session.ts && cat src/auth/limiter.ts",
                Read,
                none,
                &[
                    "src/auth/login.ts",
                    "src/auth/session.ts",
                    "src/auth/limiter.ts",
                ],
                None,
            ),
            (
                "nl -ba src/auth/login.ts | sed -n '40,90p'",
                Read,
                none,
                &["src/auth/login.ts"],
                None,
            ),
            (
                "grep -rn \"RateLimiter\" src",
                Search,
                none,
                &["RateLimiter in src"],
                None,
            ),
            (
                "rg --files -g '*.test.ts'",
                Search,
                none,
                &["*.test.ts"],
                None,
            ),
            (
                "find src -name '*limiter*'",
                Search,
                none,
                &["*limiter* in src"],
                None,
            ),
            (
                "rg -n \"legacyLimiter\" src",
                Search,
                none,
                &["legacyLimiter in src"],
                None,
            ),
            ("ls -la src/auth", Read, list, &["src/auth"], None),
            ("rg --files", Read, list, &[], None),
            (
                "sed -i '' 's/maxAttempts: 5/maxAttempts: 10/' src/auth/config.ts",
                Edit,
                none,
                &["src/auth/config.ts"],
                None,
            ),
            (
                "mkdir -p src/auth/limits && cat > src/auth/limits/window.ts <<'EOF'\nexport const window = 60;\nrm -rf /\nEOF",
                Edit,
                none,
                &["src/auth/limits/window.ts"],
                None,
            ),
            (
                "printf 'export {};\\n' | tee src/auth/limits/index.ts",
                Edit,
                none,
                &["src/auth/limits/index.ts"],
                None,
            ),
            (
                "rm -f coverage/*.json && rmdir coverage",
                Delete,
                none,
                &["coverage/*.json", "coverage"],
                None,
            ),
            (
                "cd apps/desktop && npm run typecheck",
                Run,
                none,
                &[],
                Some("apps/desktop"),
            ),
            ("rm -rf dist && npm run build", Run, none, &[], None),
            (
                "rg -l legacy src | xargs sed -i '' 's/legacy//'",
                Run,
                none,
                &[],
                None,
            ),
            ("rm -rf \"$TMPDIR/limiter-cache\"", Run, none, &[], None),
            (
                "python3 - <<'PY'\nimport os\nos.remove('x')\nPY",
                Run,
                Some(Variant::Script),
                &["python3"],
                None,
            ),
            ("npm run test:limiter", Run, none, &[], None),
            ("rm -rf node_modules", Delete, none, &["node_modules"], None),
        ];
        for (command, kind, variant, targets, folder) in cases {
            let expected = (
                *kind,
                *variant,
                targets.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>(),
                folder.map(str::to_owned),
            );
            assert_eq!(row(&zsh(command)), expected, "{command}");
        }
    }

    #[test]
    fn wrappers_are_removed_up_to_two_deep() {
        let read = row(r#"/bin/bash -lc "zsh -lc 'cat README.md'""#);
        assert_eq!((read.0, read.2), (Kind::Read, vec!["README.md".to_owned()]));
        let delete = row(r#"powershell.exe -NoProfile -Command "Remove-Item hello.txt""#);
        assert_eq!(
            (delete.0, delete.2),
            (Kind::Delete, vec!["hello.txt".to_owned()])
        );
        assert_eq!(
            shell("/bin/zsh -lc 'cd apps/desktop && npm run typecheck'").command,
            "npm run typecheck"
        );
    }

    /// Quotes that do not balance leave the command wrapped, as written.
    #[test]
    fn an_unbalanced_wrapper_stays_a_command_as_written() {
        let command = r#"/bin/zsh -lc "python3 -c 'token=[REDACTED]"key\"]'""#;
        let ran = shell(command);
        assert_eq!((ran.kind, ran.command.as_str()), (Kind::Run, command));
    }

    #[test]
    fn a_read_says_which_lines() {
        let read = shell("sed -n '1,120p' src/auth/limiter.ts");
        assert_eq!(read.targets[0].lines, Some((1, 120)));
        let numbered = shell("nl -ba src/auth/login.ts | sed -n '40,90p'");
        assert_eq!(numbered.targets[0].lines, Some((40, 90)));
    }

    #[test]
    fn a_pipeline_that_writes_later_is_a_command() {
        assert_eq!(row("cat a.ts | tee b.ts").0, Kind::Run);
        assert_eq!(row("grep -n x a.ts | head -5").0, Kind::Search);
        assert_eq!(row("npm test > out.log").0, Kind::Run);
        assert_eq!(row("cat a.ts 2>/dev/null").0, Kind::Read);
        assert_eq!(row("find . -name '*.tmp' -exec rm {} +").0, Kind::Run);
        assert_eq!(row("sed -i '' s/a/b/ a.ts && rm b.ts").0, Kind::Run);
    }
}
