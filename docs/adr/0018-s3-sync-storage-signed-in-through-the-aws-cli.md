# An S3 bucket as Workspace sync storage, signed in through the AWS CLI

## Decision

Workspace sync can store its folder in an S3 bucket as well as in Google Drive. One Workspace still has one storage destination. Everything [ADR 0011](0011-markdown-file-sync-through-google-drive.md) says about files, identity, merging, Trash, History and the CLI applies unchanged; this decision covers only the storage side. Drive references and uploaded copies stay Google Drive only.

- **Sign-in through the AWS CLI.** The person picks one of their AWS CLI profiles. ticketd gets credentials by running `aws configure export-credentials --profile <profile>`, keeps them in memory only and runs it again before they expire. ticketd stores no AWS secret: nothing goes to the OS secure store, a backup or the Workspace. When the export fails because a sign-in has ended (the CLI exits with code 253 and says the credentials could not be retrieved), sync reports that it needs the person to sign in. So does a profile that never signed in: for an SSO profile the CLI then exits with code 255 ("Error loading SSO Token"). The Sign in button runs the command the profile calls for: `aws sso login --profile <profile>` for an SSO profile, `aws login --profile <profile>` for a profile set up with `aws login`. Either opens the browser and waits for it.
- **AWS CLI 2.13 or later is required.** `export-credentials` needs 2.9 and service-specific endpoints in the config file need 2.13. Reading them with `aws configure get --services` needs 2.34.22; an older CLI answers that option with exit code 252 ("Unknown options"). A profile that names a `services` section then cannot be read, since the section may hold the S3 endpoint, and setup asks the person to update the CLI; a profile without that section never needs it. `aws login` needs 2.32 and is offered only when the profile uses it. Setup checks the version and says how to install or update the CLI.
- **ticketd makes the S3 requests itself**, over its own HTTP client with SigV4 signing by the `aws-sigv4` crate. The CLI is used for credentials, the profile list, sign-in and, in setup only, the list of the account's buckets (`aws s3api list-buckets`, which a profile without `s3:ListAllMyBuckets` may not run, and then the bucket is typed); it is never used for operations on a bucket or its objects.
- **Endpoint and region.** The endpoint is read from the profile with `aws configure get`, including, from CLI 2.34.22, the one in a service-specific `s3` section, which is how S3-compatible services are reached. A profile with a `services` section needs the newer CLI, whether or not the endpoint is in it. `aws configure get` reads only the config file, not environment variables; an app opened from Finder does not see the shell's environment either. For AWS, the region is the bucket's own, taken from the `x-amz-bucket-region` header of HeadBucket. For another service, the first request is signed with the profile's region (`us-east-1` when it sets none), and that region is kept when the service sends no region header, so the profile's region is where a signing-region mismatch is corrected.
- **Setup.** Pick a profile (from `aws configure list-profiles`), sign in if needed, then choose a bucket (listed when the credentials may list buckets, typed otherwise) and a key prefix, `ticketd/` by default. Setup checks the bucket instead of trusting a list of services (see below). Then the Upload, Download and Reconnect choices work as with Drive. Reconnect is offered for the same bucket and prefix when the folder is still there.
- **What stays on each desktop.** The profile name and the path to the `aws` program are personal state, like credentials: another desktop picks its own profile that reaches the same bucket. The bucket, prefix, folder identity and S3 service (the endpoint the profile reached when the bucket was connected, empty for AWS itself) are what the Workspace is bound to.
- **One bucket stays on one service.** A profile can be edited to reach another endpoint, and sync then must not quietly sign requests for a different service, or go on with the old one. When a bound Workspace's profile reaches a different endpoint than the one recorded, sync stops with a message that the profile now points to another service, before any request is sent, and resumes when the profile points back. There is no in-place confirmation: moving a bucket on purpose is Disconnect, then connect again, which records the new service. Another profile that reaches the same service is still the desktop's own choice. A binding made before the service was recorded takes the profile's service on its next successful build, so nothing stops for it. A profile's region is not part of this: AWS buckets carry their own, and for another service the endpoint is what identifies it.
- **An ended sign-in is quiet.** An IAM Identity Center session lasts 8 hours by default, and the person's organization can set it from 15 minutes to 90 days. When it ends, sync shows that it needs sign-in in the status line and on the settings page, with the Sign in button, and never opens a dialog. Changes keep saving locally and upload after sign-in.
- **Opening the folder.** For an AWS bucket, sync settings offer Open in AWS console. For any other service they offer Copy `s3://` address.
- **Finding the CLI.** A macOS app opened from Finder does not get the shell's `PATH`, so ticketd looks in the usual install locations (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) and lets the person choose the program when it is not found.
- **Settings.** Workspace sync gets its own Workspace sync settings page, for either storage: the storage choice, the profile, the bucket, the sign-in state and the folder actions. The Google Drive page keeps only what is Google Drive's own, the Drive attachments (references and uploaded copies). Sync no longer lives on a page named after Google Drive.

## Which services work

A service needs Versioning, `If-None-Match: *`, `If-Match` and SHA-256 checksums. As of 2026-11-23:

- **Confirmed:** AWS S3, MinIO and Ceph RGW 20.x (Tentacle). The MinIO community repository was archived on 2026-04-25.
- **Excluded:**
  - **Cloudflare R2** has no object versioning.
  - **The Google Cloud Storage XML API** ignores the S3 conditional headers (it uses `x-goog-if-generation-match` instead) and has no SHA-256.
  - **S3 Express directory buckets** have no Versioning.
- **Not documented:** Backblaze B2, Wasabi and DigitalOcean Spaces do not document conditional writes, and B2 is reported to answer 501. They are neither promised nor refused by name.

A list of services goes out of date, so **every bucket is checked at setup**. Setup refuses a bucket that does not have Versioning enabled, and one that does not honour conditional writes: it creates a marker object twice with `If-None-Match: *` and expects the second to fail. The same check reads the marker back and lists the prefix, so missing permissions, a KMS key the profile cannot use and similar bucket settings are reported before the first sync, and a refusal names the requirement the bucket fails.

## Layout in the bucket

`<prefix><folder-id>/` holds one Workspace folder, with a small marker object that holds its readable name. Records are stored under the same subfolders as in Drive, keyed by GUID (`tickets/<guid>.md`). An S3 key cannot be renamed without copying and deleting, and sync never deletes, so the readable name cannot be the key. The files are the same readable Markdown, but browsing the bucket shows GUIDs.

Each object carries two things besides its content:

- **The readable file name**, in `Content-Disposition` as `filename*=UTF-8''…` (RFC 5987), so a download from the console is saved under it. It is not user metadata: metadata is limited to 2 KB, and non-ASCII values come back RFC 2047-encoded (AWS's own example comes back garbled). The name a listing shows is derived from the key, because a version listing returns neither metadata nor headers.
- **ticketd's own SHA-256** of the content, as ASCII hex in user metadata. It is checked after every download. S3's checksums cannot serve: for a multipart upload SHA-256 exists only as a composite of the parts, and whole-object checksums exist only for CRC32, CRC32C and CRC64NVME. A single-part write also sends `x-amz-checksum-sha256` (base64), which S3 verifies.

A file uploaded by hand (`aws s3 cp`) has neither. A missing name or hash is therefore normal: the name is not needed to find the file, and the hash is computed from the bytes when it is absent.

## How the storage interface maps onto S3

- **`version`** is the object's VersionId, so a past version downloads by it and `revisions` lists the object's versions.
- **Updating a file.** A write cannot be conditional on a VersionId: S3 conditions a write only on the ETag (`If-Match`) or on the key being absent (`If-None-Match: *`). An update therefore checks that the current VersionId is the expected one, then writes with `If-Match` on the current ETag. A different write in between changes the ETag, and S3 answers 412, which becomes a precondition error instead of a replaced file. An identical write in between has the same content and so the same ETag. It is the same merge base, so overwriting it loses nothing and is harmless. The short window ADR 0011 accepts for Drive does not exist.
- **Creating a file** sends `If-None-Match: *`. It succeeds when the current version is a delete marker, so a file written again after a delete is created like a new one.
- **Answers to a conditional write:**
  - **404 on `If-Match`** means the key is missing or its current version is a delete marker. It is read as _file missing_, not as a failed write, and the file is created again.
  - **409 `ConditionalRequestConflict`** means another conditional write to the key was in progress. A PutObject is retried from the version check. A CompleteMultipartUpload that answers 409 starts the upload again.
  - **412** is the precondition error above.
- **CompleteMultipartUpload can answer HTTP 200 with an error in the body**, so the body is always parsed.
- **Large uploads.** Attachments over 16 MiB upload in parts, so an interrupted upload resumes from the last finished part. The upload completes with `If-None-Match: *`, since an Attachment's file is written once.
- **`file_id` and `created`** come from the file's latest delete marker: its VersionId and time, or a fixed value when there is none. They are not taken from the oldest version after the delete marker, because a lifecycle rule that removes noncurrent versions would change that. An object deleted and written again is therefore another file, as with Drive. Removing the delete marker brings back the earlier identity, which is seen as an older file restored: values that differ go to Needs review, as for a file restored from Drive's trash.
- **Listing.** ListObjectVersions returns versions sorted by key, newest first, with delete markers interleaved, and the order is kept. A page holds at most 1,000 entries and continues with `key-marker` and `version-id-marker`. Versions carry ETag, size, VersionId, IsLatest, LastModified and the checksum algorithm but no checksum value; delete markers carry no ETag or size.
- **Storage errors** map onto the existing recovery states: expired or refused credentials to _needs sign-in_, a missing bucket or marker to _folder missing_, `SlowDown` and 503 to _rate limited_, no network to _offline_. As in ADR 0011, a missing file or an empty listing is never read as a deletion.

## The IAM policy

ticketd cannot limit itself to its prefix the way `drive.file` does; the person's IAM policy can, with the prefix as a resource. The least a profile needs:

- **Bucket:** `s3:ListBucket` (also for HeadBucket), `s3:ListBucketVersions` and `s3:GetBucketVersioning`. Optionally `s3:ListAllMyBuckets`, which lets setup offer a list of buckets.
- **Objects:** `s3:GetObject`, `s3:GetObjectVersion` and `s3:PutObject`. `If-Match` also needs `s3:GetObject`.
- **Multipart uploads:** `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` and `s3:ListBucketMultipartUploads`. The bucket check tries `s3:ListBucketMultipartUploads`, but not the other two. A missing `s3:ListMultipartUploadParts` shows only when an interrupted upload is resumed. A missing `s3:AbortMultipartUpload` is logged, not reported, so abandoned parts can stay in the bucket, and be billed, until a lifecycle rule that aborts incomplete multipart uploads removes them.
- **A bucket encrypted with a KMS key:** also `kms:GenerateDataKey` and `kms:Decrypt` on that key.

## Why

- **People who keep their data in AWS or an S3-compatible service can sync without Google.**
- **The CLI's credentials cover every way people sign in to AWS** (IAM Identity Center, assume-role chains, MFA, `credential_process` helpers such as aws-vault, static keys) with no code for any of them in ticketd, and leave no secret for ticketd to protect.
- **S3 is a better fit for the storage interface than Drive.** It has conditional writes and strongly consistent listings.

## Rejected

- **Running each S3 operation as an `aws` command.** Every call would start a process (around half a second), behaviour would depend on each person's CLI version (2.19.5 has `--if-none-match` on `put-object` but no `--if-match`, which sync's safe update needs), failures would be read from error text, and large transfers would show no progress.
- **The AWS SDK for Rust.** It needs `tokio` in a core that is blocking throughout, makes builds much heavier, and would be a second credential chain beside the CLI's.
- **`rusty-s3`.** It produces presigned URLs only and has no ListObjectVersions.
- **Access keys kept in the OS secure store.** That covers only static keys and makes ticketd responsible for long-lived secrets.

## Consequences

- S3 sync needs AWS CLI 2.13 or later on each desktop, bucket Versioning, and a service that honours conditional writes. Services that do not are excluded, and setup says why. Buckets whose objects move to an archive storage class, Requester Pays buckets and directory buckets do not work either.
- A person without an AWS CLI profile creates one in a terminal (`aws configure` or `aws configure sso`) first; ticketd does not create profiles.
- A second desktop finds the Workspace folder only in a bucket it is told about: without permission to list buckets, the bucket is typed on each desktop.
- Browsing the folder is weaker than in Drive: keys are GUIDs and the console neither searches nor previews Markdown. A hand edit means downloading and uploading the file again.
- The person pays their provider for requests, storage and kept versions. On AWS in us-east-1, polling once a minute costs about $0.22 a month per desktop, plus one more list request for each additional 1,000 versions. A refused conditional write is a 4XX answer and is billed too.
- Content is stored unencrypted by ticketd, as in Drive. Encryption at rest is the bucket's configuration.
- Change discovery lists the folder's versions, so its cost grows with history. A lifecycle rule that expires noncurrent versions after more than 30 days bounds it without affecting History. A cheaper listing was looked for and does not exist: ListObjectsV2 returns no VersionId, and ListObjectVersions cannot skip a key's older versions, while `version` is the VersionId and a file's identity is its latest delete marker, which only the version listing shows. A write reads a single key's versions only down to its latest delete marker, so its cost does not grow with the folder.
- The sync binding records which storage provider it uses, a Workspace format change. Sync settings and the core's messages name the provider instead of saying Google Drive.
- The storage interface states which capabilities a provider has (conditional writes, revisions), since Drive and S3 differ.
- Whether storage providers can be added as extensions outside ticketd is a separate decision.
