# Ticket source extensions

An extension is a local executable that connects ticketd to a tracker. It runs as
your OS user. Install code you trust, including the dependencies and interpreter
it launches.

`ticketd source extension add PATH` copies a local package after showing its exact
program, arguments, version, ID, and declared hosts for approval. Add it again
after changes to the installed copy. The package must contain regular files and
directories. A PATH command resolves to an absolute path when you approve it.

Use `ticketd source extension list` to see registrations and
`ticketd source extension remove ID` to remove one. For authors, `link PATH`
keeps the original build folder and marks the extension as Development in
Settings.

Use Node 22.23.4 to try the [TypeScript example](../../examples/ticket-source-example-ts/tracker.ts)
from this repository. Make sure `node` is available on the PATH used to start
ticketd, including when the desktop starts it.

```sh
ticketd source extension link examples/ticket-source-example-ts
ticketd source conformance example-tracker --set board=Demo --strict
```

In Settings → Sources, add an Example Tracker connection. Enter `Demo` as the
board, preview matches, save, and select Sync now. The example uses local data
and sends no network requests. `ticketd source add example-tracker --set board=Demo`
and `ticketd source example-tracker refresh` provide the corresponding CLI flow.
The example also has a `Sign-in` board that accepts any nonblank synthetic API
key. Try it to exercise the optional `secret` field.

## Manifest

Put `ticketd-source.json` in the folder you add or link. Its `id` is the stable provider
ID and uses lower-case letters, digits and hyphens. `version` is the extension
version. `executable` is a PATH command or a path such as `./tracker` relative
to the folder. Optional `args` is an array of command arguments. Optional
`hosts` and `env` list the network hosts and extra environment variables the
extension expects.

The extension starts in its registered folder. It inherits a small set of operating
system, locale, PATH, temporary-directory and proxy variables, plus named
manifest variables. Variables beginning with `TICKETD_` are removed. Close
the extension when stdin reaches EOF. Use stderr for diagnostics and keep
stdout dedicated to JSON-RPC. Each connection's recent stderr is available in
the local logs and Diagnostics export with known secrets redacted. Link a
development folder again after changing the manifest or the description it reports.

## Contract 2

[JSON Schema](contract-2.schema.json) describes the request and response shapes.
The schema is generated from the Rust types used by the connector. Regenerate it
from the repository root when the protocol types change.

```sh
cargo run --quiet --locked -p ticketd-core --example source_contract_schema \
  > docs/source-extensions/contract-2.schema.json
```

Each message is one UTF-8 line of JSON-RPC 2.0 ending with a newline. The host
sends `describe` first. Its parameters are `contract_versions` and the host's
`pid`. Return your supported versions in `contract_versions` and select an offered
version in `contract_version`. On a mismatch, return null for the version and
the description so ticketd can report both sides. On success, return your
extension `version` and a `description` with the provider ID, display name,
chosen contract version, capabilities, settings schema and presentation.

Reply with the same numeric `id` and exactly one of `result` or `error`. Each
operation after `describe` carries an explicit `connection_id` and `config`. A
provider can have several local connections. An issue's external identity uses
the provider ID and a stable tracker ID unique across the provider's accounts
and sites.

Declare credentials as fields of type `secret`. ticketd supplies active
secrets in each operation's `config`, alongside discovery settings. Treat
them as request-scoped values. Keep them out of the extension's files,
environment, results and diagnostics, including transport error messages.
ticketd redacts exact known values and common JSON, URL and Base64 forms from
diagnostics. It rejects results that echo a known credential. Conformance flags
credential-like field names that use another type.

| Method             | Result                                       |
| ------------------ | -------------------------------------------- |
| `check_connection` | Account, site and derived discovery settings |
| `validate`         | Settings problems, an empty array on success |
| `options`          | Choices for a dynamic settings field         |
| `discover`         | One page and an optional continuation        |
| `fetch`            | One issue                                    |
| `conversation`     | Comments and timeline events                 |
| `publish`          | The created open issue                       |
| `locate`           | One issue within the supplied destination    |
| `find_published`   | Possible matches for an uncertain publish    |

Declare `discover` and `fetch`. Declare `comments` for `conversation`. Declare
`publish` when you implement all three publication methods. Discovery may return
an empty page with a continuation. Report the canonical parts covered by
discovery from `check_connection` and put the matching part on each issue
reference. Use the tracker's typed state for ticketd's state category and keep its
state name as display text. Return `unknown` when the tracker did not give a
recognized state. Missing or inaccessible issues are errors.

A domain failure uses JSON-RPC error code `-32000` with `data` holding a stable
`code`, a `class` and a person-readable `message`. Configuration failures can
include `fields`. A rate limit can include `retry_after_secs`. Use `not_sent`
only when the tracker could not have acted. A lost reply or an ambiguous
publication must stay unresolved.

### Reporting progress and canceling requests

While processing a request, send a JSON-RPC `progress` notification. Put the
active request's numeric `id` in `params`, along with the nonnegative
`completed` count and the optional `total` count. Counts describe the work
inside that request. Omit `total` when you do not know it.

```json
{
  "jsonrpc": "2.0",
  "method": "progress",
  "params": { "id": 7, "completed": 42, "total": 100 }
}
```

An ordinary call has a 30-second inactivity timeout. Each matching progress
notification restarts that timer, within five minutes of the original request.
The startup handshake has a fixed five-second limit.

When a call expires or the person cancels it, ticketd sends a `cancel`
notification for a request it sent in full.

```json
{ "jsonrpc": "2.0", "method": "cancel", "params": { "id": 7 } }
```

Read stdin while your request is running. Stop the matching work, then reply
once to the original `id` with JSON-RPC error `-32800`. The notification itself
has no response. Stop sending progress for a request before its final reply.
If the request already finished, its normal reply can cross the cancellation
notification. ticketd discards that reply. If no terminal reply arrives within
about two seconds, ticketd terminates the process tree. The next request starts
a new process. Closing stdin still asks the extension to exit.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": { "code": -32800, "message": "Request canceled" }
}
```

In Settings → Sources, use **Cancel sync** while a manually started sync runs.
In a terminal, `ticketd source CONNECTION refresh` shows progress on stderr
and uses Ctrl+C to stop the refresh. The CLI returns exit status 130 on cancellation.

Conformance cancels a read-only `discover` call when it sees the first progress
notification and checks for a cancellation response. Strict conformance requires
a discovery fixture that reports progress long enough to exercise this path.

Conformance is read-only unless you pass `--publish DESTINATION`, which creates
one real issue and checks the recovery queries. Use a test destination. The
report explains which checks need capabilities or data unavailable in the run.

## Supplying credentials

Enter them when adding or editing a connection under **Settings → Sources**.
When a tracker refuses authentication, **Needs sign-in → Re-enter credentials**
opens the credential fields by themselves. In the CLI, pipe a JSON object of
those fields to `ticketd source CONNECTION sign-in --config-file -`.

For each request, ticketd checks the current draft value, a direct environment
override, a password command, the session store and the operating system
keychain, in that order. The environment variable is
`TICKETD_SOURCE_<CONNECTION>_<FIELD>`. Uppercase the connection ID and field
key and replace characters outside ASCII letters and digits with underscores.
The override is read by ticketd and stripped from extension processes. Launch
ticketd or its desktop app with the variable in its environment. For example,
this asks 1Password to supply the example connection's key when needed:

```sh
export TICKETD_SOURCE_EXAMPLE_TRACKER_API_KEY_COMMAND='["op","read","op://Example/Tracker/credential"]'
ticketd source example-tracker refresh
```

The `_COMMAND` value is a JSON array of executable and argument strings.
ticketd runs the command directly, with no shell or interactive input, and
reads its UTF-8 stdout for up to five seconds. Keep secret literals out of the
command arguments. Set the environment with the secret manager or system
launcher when using the desktop. The CLI can read a typed credential from
stdin during setup through `source add PROVIDER --config-file -`.

On Linux, if Secret Service is missing or locked, a credential entered in
ticketd lasts until that ticketd process closes. Startup and refresh never
trigger an unlock prompt. On macOS, an ad hoc preview or rebuilt binary can
lose access to an item created by another build or by the other ticketd
executable. Re-enter the credential in the app or executable you use, or use
an override or password command. On Windows, Credential Manager accepts up to
2,560 UTF-8 bytes per credential. Windows enterprise profile policy can roam
credential entries. ticketd keeps their connection references on the device.
