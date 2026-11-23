# Ticket source extension contract

The [author guide](../ticket-source-extensions.md) covers packaging, development,
the protocol, and conformance. The [Contract 2 JSON Schema](contract-2.schema.json)
describes the wire messages.

Regenerate the schema from the repository root when the SDK's protocol types
change.

```sh
cargo run --quiet --locked -p ticketd-core --example source_contract_schema \
  > docs/source-extensions/contract-2.schema.json
```

## Supplying credentials

See [Supplying credentials](../ticket-source-extensions.md#supplying-credentials)
in the author guide.
