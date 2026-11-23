# Testing S3 sync storage

The S3 adapter ([ADR 0018](adr/0018-s3-sync-storage-signed-in-through-the-aws-cli.md)) is tested
on two layers. Neither needs an AWS account.

## Simulator tests

`cargo test -p ticketd-core --test s3_remote --test remote_contract --locked` runs the adapter
on a small stateful S3 simulator (`crates/ticketd-core/tests/support/s3_sim.rs`). It injects
faults (throttling, lost answers, expired credentials) and checks the exact requests. The
`remote_contract` suite is the one every sync storage must pass: the in-memory fake, the Drive
adapter and the S3 adapter. These tests run offline in the ordinary suite and in `./scripts/check`.

## Live tests against MinIO

The same contract suite, and tests of what the adapter assumes about a real server (conditional
writes, delete markers and file identity, paging past a thousand versions, ranged reads, names
and hashes in headers), run against a MinIO with Versioning on. They are opt-in: without
`TICKETD_S3_TEST_ENDPOINT` they return at once, so nothing else changes.

With Docker running:

```sh
eval "$(scripts/minio-test-server start)"      # starts MinIO on 127.0.0.1:9000, prints the variables
cargo test -p ticketd-core --locked --test remote_contract --test s3_live -- live_
scripts/minio-test-server stop
```

The tests create the bucket (`ticketd-live-test`, or `TICKETD_S3_TEST_BUCKET`) and turn
Versioning on, and keep each run's data under its own prefix. `TICKETD_S3_TEST_REQUIRED=1` turns
a missing endpoint into a failure, which is how CI runs them. Any S3-compatible server works
when you set `TICKETD_S3_TEST_ENDPOINT`, `TICKETD_S3_TEST_ACCESS_KEY` and
`TICKETD_S3_TEST_SECRET_KEY` yourself; use a throwaway bucket, because the tests write to it.

CI runs them as the `S3 storage (MinIO)` job, part of the `CI result` check. To add a live test,
put it in `crates/ticketd-core/tests/s3_live.rs` (or `remote_contract.rs` for the shared contract)
and name it `live_…`; the job picks it up without a workflow change.

### The pinned MinIO

MinIO's community repository is archived, and its official images can no longer be pulled from Docker Hub or
Quay. `scripts/minio-test-server` pins `bitnamilegacy/minio` 2025.7.23 (MinIO
`RELEASE.2025-07-23T15-54-02Z`) by digest, on purpose: a moving tag would let a server change
break the check. Move the pin only after running the live tests against the new image.

### What MinIO does not cover

On this MinIO, every live test passes: Versioning, `If-None-Match`, `If-Match`, SHA-256
checksums, delete markers and version listing behave as the adapter needs. What the live tests
cannot reach stays on the simulator: throttling and server failures, expired and refused
credentials, lost answers, and exact request shapes. AWS S3 itself (virtual-hosted addressing,
regional endpoints, its exact error bodies) is not exercised by any automated test.
