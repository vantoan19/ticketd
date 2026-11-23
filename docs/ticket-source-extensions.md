# Write a ticket source extension

A ticket source extension connects a tracker to ticketd. The extension translates
tracker data into Contract 2. ticketd manages source connections, runs discovery
and refresh, and stores the results. You can use any language that reads and
writes UTF-8 on standard input and output.

## Try the TypeScript example

From the ticketd checkout, use the Node version in [`.nvmrc`](../.nvmrc)
and a ticketd CLI that supports Contract 2. Make sure `node` is on the PATH of
the process that launches the CLI or desktop. The [example package](../examples/ticket-source-example-ts)
uses synthetic issues and makes no network requests.

```sh
ticketd source extension link examples/ticket-source-example-ts
ticketd source conformance example-tracker --set board=Demo --strict
```

The link returns the extension registration. The conformance report should have
`"passed":true`, including a passed `cancellation` check. Each skipped check
has a reason. In **Settings → Sources**, add an **Example Tracker** connection
with board `Demo`, preview the matches, and save. Select **Sync now** to import
the two sample issues. The same setup and refresh are available in the CLI.

```sh
ticketd source add example-tracker --set board=Demo
ticketd source example-tracker refresh
```

Use the connection ID returned in `source.id` if it differs from `example-tracker`.
The example's `Sign-in` board accepts a nonblank synthetic API key and shows how
a tracker can require a credential only for some settings.

## Package and link your extension

Put the runnable program and a file named `ticketd-source.json` in one folder.
This manifest launches an executable named `tracker` from a POSIX package.

```json
{
  "id": "sample-tracker",
  "version": "0.1.0",
  "executable": "./tracker",
  "hosts": []
}
```

| Field        | Meaning                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Stable provider ID. Start with a lowercase ASCII letter, use lowercase ASCII letters, digits and hyphens, and end with a letter or digit. The maximum is 64 characters. Built-in IDs and reserved CLI names are unavailable. |
| `version`    | Extension version, also returned by `describe`. This is separate from the protocol version.                                                                                                                                  |
| `executable` | A PATH command or a relative path inside the package such as `./tracker` or `./tracker.exe`. A PATH command can launch an interpreter.                                                                                       |
| `args`       | Optional array of argument strings passed directly to the program. Paths such as `tracker.ts` resolve from the package directory.                                                                                            |
| `hosts`      | Optional array of declared network hostnames or IP addresses. ticketd displays them at approval and in Settings.                                                                                                             |
| `env`        | Optional array of extra environment variable names. Use letters, digits and underscores.                                                                                                                                     |

Run `ticketd source extension link PATH` on your build folder. Linking runs a
startup handshake and records the folder as **Development**. Rebuild the
executable in place and run conformance again. Relink when you change the
manifest or the description returned by the executable, since ticketd caches
the registration and description. Use `ticketd source extension list` to
inspect registrations and `ticketd source extension remove ID` to remove one.
For an isolated registry and database with a debug build, follow the
[disposable workspace setup](development.md#use-a-disposable-workspace) and set
`TICKETD_SOURCE_EXTENSIONS_DIR` to a separate absolute directory.

To install a copy, run `ticketd source extension add PATH`. ticketd shows the
exact executable, arguments, working directory, provider ID, version and
declared hosts before running it. Review the package, its dependencies and any
interpreter it launches. Extensions run as your OS user with access to its
files and network. The host list informs approval. The installed copy must
contain regular files and directories, and a PATH executable resolves to an
absolute path when approved. ticketd checks the installed folder's hash before
use and blocks a changed copy until you add it again. A linked folder runs its
current contents without that hash check.

## Speak Contract 2

Use the [Contract 2 JSON Schema](source-extensions/contract-2.schema.json) for
the complete wire shapes. Each message is one JSON-RPC 2.0 object on a single
UTF-8 line ending in a newline, within the 4 MiB frame limit. Write only
protocol traffic to stdout and send diagnostics to stderr. Reply with the
request's numeric `id` and exactly one of `result` or `error`.

`describe` is the first request. Its `params` contain the host's
`contract_versions` and `pid`. Return the versions you support and select a
shared version. For example, a minimal Contract 2 description can return the response shown below. Serialize it on one line.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "contract_versions": [2],
    "contract_version": 2,
    "version": "0.1.0",
    "description": {
      "provider": "sample-tracker",
      "name": "Sample Tracker",
      "contract_version": 2,
      "capabilities": ["discover", "fetch"],
      "schema": { "fields": [] },
      "presentation": {}
    }
  }
}
```

If no offered version is supported, return your version list and extension
version with `contract_version` and `description` set to `null`. At a
successful handshake, the provider ID and extension version must match the
manifest. Change the contract version for changes to existing behavior or
required shapes. An optional addition can use the same version.

Every operation after `describe` includes an explicit `connection_id` and
`config`. Use the current config for the current request. Two connections can
use the same extension with different accounts, sites or discovery rules.

| Method             | Result                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_connection` | Verified account and site, plus derived discovery and publication settings.                                                                         |
| `validate`         | Settings problems. Return an empty array for valid settings, or return a problem with a `field` key for one input or without it for the whole form. |
| `options`          | Choices for the requested dynamic setting, using its `field`, `query` and current settings.                                                         |
| `discover`         | One page of matching issues, with `next_cursor` for the next page or `null` to finish.                                                              |
| `fetch`            | The current issue identified by `reference`.                                                                                                        |
| `conversation`     | Comments and timeline events. Declare `comments` to enable this operation.                                                                          |
| `publish`          | The newly created open issue.                                                                                                                       |
| `locate`           | The matching issue within the supplied destination.                                                                                                 |
| `find_published`   | Possible matches for a publication after ticketd could not confirm the outcome.                                                                     |

Declare `discover` and `fetch` for every extension. Implement `publish`,
`locate` and `find_published` together before declaring `publish`. For a
minimal read-only extension with an empty schema, implement `validate` as
an empty array. This is a minimal `check_connection` result.

```json
{
  "connection": { "account": "demo", "site": "" },
  "derived": {
    "partitions": [""],
    "discovery_scope": "",
    "publication": { "destinations": [], "case_insensitive": false }
  }
}
```

The empty site and partition identify a single-site tracker read as one
whole. For a real tracker, use canonical site and partition keys, and set
`account_id` when the display label can change or is shared. The
`discovery_scope` key is stable for a particular set of filters and empty
when discovery reads the whole partition.

A trivial fixture can return one fixed issue from its first discovery page
and return the same issue by identity from `fetch`. A page is
`{ "issues": [ISSUE], "next_cursor": null, "skipped": [] }`. The schema's
`ExternalIssue` definition lists the fields for `ISSUE`. Supply UTC timestamps
in RFC 3339 format. Use an opaque immutable
ID unique across all accounts and sites of this provider, with the provider in
`reference.identity`. Each `reference.partition` matches a partition from
`check_connection`. Use the tracker's typed state for `state.category`, with
its original state name in `state.name`. The categories are `open`,
`completed`, `not_planned`, `duplicate` and `unknown`. An absent or
inaccessible issue is an error. Only positive tracker evidence can confirm a
terminal state. Comment and event IDs are stable across repeated reads.

For conversation events, `state_changed` carries the destination category
and the workflow state name as its subject. `marked_duplicate` and
`unmarked_duplicate` describe this issue's link to an original.
`duplicate_added` and `duplicate_removed` describe links from other issues to
this one. Use the related issue's display identifier as the subject.
`closed` and `reopened` carry lifecycle evidence.

Honor `page_size` and treat the cursor as an opaque continuation that belongs
to the extension. An empty page may still have a continuation. A valid cursor
beyond the last page returns an empty page without a continuation.

## Lifecycle, progress and cancellation

The desktop starts one process per connection on demand and stops it after five
idle minutes or at quit. The CLI closes its processes before returning. Exit
when stdin closes. The host manages the process tree and stops descendants on
forced shutdown. A crash fails the call. The host restarts the process on the
next call until the connection reaches five crashes within three minutes.
**Retry** clears that crash limit.

The handshake has five seconds. An ordinary request has a 30-second inactivity
timeout and a five-minute hard deadline. To keep a long call active, send a
`progress` notification with the active request's ID and the amount of work
completed within that request. Omit `total` when unknown.

```json
{
  "jsonrpc": "2.0",
  "method": "progress",
  "params": { "id": 7, "completed": 42, "total": 100 }
}
```

Keep reading stdin while a request is in flight. If a person cancels or the
call times out after the request was fully sent, ticketd sends a notification.

```json
{ "jsonrpc": "2.0", "method": "cancel", "params": { "id": 7 } }
```

Stop the matching work and progress, then send one terminal response to the
original request ID. The notification itself has no response.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": { "code": -32800, "message": "Request canceled" }
}
```

A response already sent can cross the cancel notification and ticketd discards
it. If the process sends no terminal response within about two seconds,
ticketd terminates the process tree. The next request starts a new process.

## Report errors

Use JSON-RPC error code `-32000` for tracker and configuration errors. Put
a stable `code`, its matching `class`, and a message for the person in
`error.data`. This error reports a rejected credential.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32000,
    "message": "Source operation failed",
    "data": {
      "code": "unauthenticated",
      "class": "auth",
      "message": "The tracker rejected the API key."
    }
  }
}
```

| Class       | Codes                                            |
| ----------- | ------------------------------------------------ |
| `config`    | `invalid_configuration`, `not_found`, `rejected` |
| `auth`      | `unauthenticated`, `forbidden`                   |
| `transient` | `rate_limited`, `unavailable`, `not_sent`        |
| `system`    | `protocol`, `unsupported`                        |

For `invalid_configuration`, `data.fields` can describe faulty inputs. For
`rate_limited`, `data.retry_after_secs` can give an integer delay.
`unauthenticated` opens the **Needs sign-in** flow. Use `forbidden` for known
access denial.

For publication, use `not_sent` when the request could not have reached the
tracker and `rejected` when the tracker explicitly refused to create the issue.
A timeout, lost response or ambiguous tracker answer leaves publication
unresolved. Report an appropriate `unavailable` or `protocol` error, so
ticketd can check for a created issue before allowing another write.
In `find_published`, report the search as complete only if you finished
reading the relevant issues in that destination.

## Describe forms and presentation

The `description.schema` defines the same settings for the desktop and CLI.
Use `text` for a single value, `multi_select` for an ordered list with static or
dynamic choices, `secret` for a credential and `link` for an informational
HTTPS link. A field can set `required`, `help`, `placeholder`, an
applicable pattern with a corrective message, or `advanced`. A `show_if`
references another field and the dependent value is omitted when the other field
is empty or hidden. A dynamic choice can declare input dependencies through
`options.depends_on`. ticketd combines schema checks with `validate` before
discovery. Return actionable feedback for combinations the schema alone
cannot express.

Put presentation in `description.presentation`. Use a monochrome SVG icon
(up to 16 KiB), an `issue_name.separator` for splitting the displayed locator
into place and number, `sign_in` hints for desktop and terminal,
`discovery_note` to describe the scope and `target` to identify the primary
discovery field. ticketd renders settings, sign-in and issue details with its
own components. It displays the hosts from the manifest.

## Supplying credentials

Set a field's type to `secret` for every credential. ticketd supplies its
current value in an operation's `config`, using a keychain reference for a saved
credential. Treat values as request-scoped. Keep them out of files, process
environment, results, stderr and error messages, including raw HTTP errors.
ticketd rejects results echoing a known credential and redacts known values
and common encodings from extension diagnostics. Recent extension stderr is
available in local logs and the desktop Diagnostics export.

The extension starts in its registered folder. It inherits a restricted set of
OS, locale, PATH, temporary-directory and proxy variables, plus those declared in
`env`. ticketd strips variables with the `TICKETD_` prefix, including
credential overrides.

Enter credentials in the connection form under **Settings → Sources**. Use
**Needs sign-in → Re-enter credentials** when the tracker rejects them.
In the CLI, pipe a JSON object with credential fields to
`ticketd source CONNECTION sign-in --config-file -`. At setup, use
`ticketd source add PROVIDER --config-file -` to read settings and
credentials from stdin.

For each request ticketd checks the current draft value, direct environment
override, password command, session store, then OS keychain. The environment
variable is `TICKETD_SOURCE_<CONNECTION>_<FIELD>`. Uppercase the connection ID
and field key and replace characters outside ASCII letters and digits with
underscores. The `_COMMAND` suffix selects a password command. This example uses 1Password.

```sh
export TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY_COMMAND='["op","read","op://Example/Tracker/credential"]'
ticketd source example-tracker refresh
```

A password command is a JSON array with executable and argument strings.
ticketd runs it directly with no shell or interactive input and waits up to
five seconds for UTF-8 stdout. Keep secret literals out of its arguments.
Set these variables in the environment of the CLI or the desktop launcher.

On Linux, without an available Secret Service, entered credentials last until
the ticketd process exits. Startup and refresh avoid unlock prompts.
On macOS, a rebuilt or ad hoc binary may need
credentials re-entered when it cannot access a keychain item saved by a
different executable. On Windows, Credential Manager accepts up to 2,560
UTF-8 bytes per credential. Windows enterprise policy can roam keychain
entries, while the references stay on the device.

## Run conformance

Run `ticketd source conformance PROVIDER` against the registered extension
using synthetic or test data. Supply ordinary settings with `--set KEY=VALUE`
or use `--config-file -` to pipe a JSON object of settings and credentials.
The conformance connection ID for environment overrides is `conformance`.
The CLI prints a JSON report and exits with an error when a check fails.

- The default run reads only. It checks version refusal, connection validation,
  discovery and stable identity, and exercises declared capabilities when the
  data allows it.
- `--strict` requires an issue to sample and fetch, and requires a process
  extension to report progress so the suite can cancel discovery and confirm
  that cancellation was acknowledged. A small synthetic delay in an abortable
  discovery request is enough to exercise the path. Strict mode applies to
  first-party extensions.
- `--publish DESTINATION` permits one actual issue creation and checks
  `locate` and recovery search. Use a dedicated test destination. The issue
  remains there for inspection.

Each skipped check has a reason. Examples include a schema with no dynamic
choices, an optional capability that is absent, and sampled pages without an
empty continuation. A live conformance run cannot invent a valid opaque
past-end cursor or arrange typed closure and ambiguous write outcomes.
Cover those with controlled tracker fixtures. Publication is skipped in a
read-only run and remains gated by `--publish` in strict mode.

## Rust SDK

The [`ticketd-source-sdk` crate](../crates/ticketd-source-sdk) supplies typed
models, handshake negotiation, the stdio loop, and error envelopes. Add it as
a Git dependency from the ticketd repository.

```sh
cargo add --git https://github.com/vantoan19/ticketd ticketd-source-sdk
```

Pin a tested commit with Cargo's `--rev` when distributing your extension.
Use the Rust toolchain in [`rust-toolchain.toml`](../rust-toolchain.toml).
Implement `Extension` with your description, connection check, discovery and
fetch, then call `serve_stdio` from your entry point. Add validation, dynamic
choices, conversation or publication as needed. Read the current connection
ID from `RequestContext`. Report progress with `RequestContext::progress`
and check `is_canceled` before network calls and between pages. Keep I/O
bounded so cancellation can be acknowledged promptly. Use `serve` with supplied
streams for protocol tests.

Call the server with your extension version and your implementation of the
trait. This entry point uses an implementation named `Tracker`.

```rust
fn main() -> std::io::Result<()> {
    ticketd_source_sdk::serve_stdio(env!("CARGO_PKG_VERSION"), Tracker)
}
```

Build the binary, put it alongside the manifest in the folder you link, and
use the same conformance command as for any other language. The
[Linear adapter](../crates/ticketd-source-linear) is a Rust implementation of
the contract. The SDK is available as a Git dependency while live Linear
verification is pending.
