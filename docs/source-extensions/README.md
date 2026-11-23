# Ticket source extensions

An extension is a local executable that connects ticketd to a tracker. It runs as
your OS user. Link code you trust, including any dependencies and interpreter
it launches. Linking points at the author's build folder on this device and
marks the extension as Development.

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

Put `ticketd-source.json` in the folder you link. Its `id` is the stable provider
ID and uses lower-case letters, digits and hyphens. `version` is the extension
version. `executable` is a PATH command or a path such as `./tracker` relative
to the folder. Optional `args` is an array of command arguments. Optional
`hosts` and `env` list the network hosts and extra environment variables the
extension expects.

The extension starts in the linked folder. It inherits a small set of operating
system, locale, PATH, temporary-directory and proxy variables, plus named
manifest variables. Variables beginning with `TICKETD_` are removed. Close
the extension when stdin reaches EOF. Use stderr for diagnostics and keep
stdout dedicated to JSON-RPC. Link the folder again after changing the manifest
or the description it reports.

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
