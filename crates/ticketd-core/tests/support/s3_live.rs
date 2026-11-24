//! A real S3-compatible server for the opt-in live tests: the same adapter and signed client as
//! production, on the production transport, against a MinIO bucket with Versioning on. The
//! simulator (`s3_sim.rs`) stays the place for faults and exact request shapes; the live tests
//! check that what the adapter assumes about S3 is true of a server that was not written for
//! the tests.
//!
//! Live tests are opt-in: without `TICKETD_S3_TEST_ENDPOINT` they return at once, so the
//! ordinary suite stays offline. Name every one `live_…` so the CI job, which runs
//! `cargo test -- live_`, picks it up without a change. `scripts/minio-test-server` starts a
//! pinned server and prints the variables; see `docs/development.md`.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Shared opt-in fixture.
use std::sync::Once;
use std::time::Duration;

use ticketd_core::s3::*;

const ENDPOINT: &str = "TICKETD_S3_TEST_ENDPOINT";
const ACCESS_KEY: &str = "TICKETD_S3_TEST_ACCESS_KEY";
const SECRET_KEY: &str = "TICKETD_S3_TEST_SECRET_KEY";
const BUCKET: &str = "TICKETD_S3_TEST_BUCKET";
const REGION: &str = "TICKETD_S3_TEST_REGION";
/// Set in CI: a missing endpoint is then a failure, not a skip, so a misconfigured job cannot
/// pass by running nothing.
const REQUIRED: &str = "TICKETD_S3_TEST_REQUIRED";

/// Static keys, as a server such as MinIO is given them.
pub struct StaticCredentials {
    access_key_id: String,
    secret_access_key: String,
}

impl CredentialSource for StaticCredentials {
    fn credentials(&self) -> Result<Credentials, AwsCliError> {
        Ok(Credentials {
            access_key_id: self.access_key_id.clone(),
            secret_access_key: self.secret_access_key.clone(),
            session_token: None,
            expires_at: None,
        })
    }

    fn forget(&self) {}
}

/// Sends any method to the server: the test's own hand on the bucket, to delete an object or
/// make one the way another tool would. The adapter never uses it.
pub struct AnyMethod {
    agent: ureq::Agent,
}

impl S3Transport for AnyMethod {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError> {
        let outcome = match request.method {
            "GET" | "HEAD" | "DELETE" => {
                let mut builder = match request.method {
                    "GET" => self.agent.get(&request.url),
                    "HEAD" => self.agent.head(&request.url),
                    _ => self.agent.delete(&request.url),
                };
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            _ => {
                let mut builder = match request.method {
                    "POST" => self.agent.post(&request.url),
                    _ => self.agent.put(&request.url),
                };
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(&request.body)
            }
        };
        let mut response = outcome.map_err(|_| S3TransportError::Offline)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
            .map_err(|_| S3TransportError::Unreadable)?;
        Ok(S3Response {
            status,
            headers,
            body,
        })
    }
}

/// The server the live tests run against, with a versioned bucket ready.
pub struct Live {
    target: S3Target,
    pub credentials: StaticCredentials,
    /// What the adapter sends through: the production transport.
    pub transport: UreqS3Transport,
    admin: AnyMethod,
    /// Where this run's Workspace folders go, so a run never sees the folders of another.
    pub prefix: String,
}

/// The live server, or `None` (the test is skipped) when no endpoint is configured.
pub fn live() -> Option<Live> {
    let Ok(endpoint) = std::env::var(ENDPOINT) else {
        assert!(
            std::env::var_os(REQUIRED).is_none(),
            "{REQUIRED} is set, but {ENDPOINT} is not"
        );
        eprintln!("skipped: set {ENDPOINT} to run this against a real S3-compatible server");
        return None;
    };
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    let target = S3Target::new(
        &std::env::var(BUCKET).unwrap_or_else(|_| "ticketd-live-test".into()),
        &std::env::var(REGION).unwrap_or_else(|_| "us-east-1".into()),
        Some(&endpoint),
    )
    .expect("the test target is valid");
    let live = Live {
        credentials: StaticCredentials {
            access_key_id: var(ACCESS_KEY),
            secret_access_key: var(SECRET_KEY),
        },
        transport: UreqS3Transport::new(target.clone()),
        admin: AnyMethod {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(120)))
                .http_status_as_error(false)
                .max_redirects(0)
                .max_redirects_will_error(false)
                .build()
                .into(),
        },
        prefix: format!("live-{}/", uuid::Uuid::new_v4()),
        target,
    };
    static BUCKET_READY: Once = Once::new();
    BUCKET_READY.call_once(|| live.prepare_bucket());
    Some(live)
}

impl Live {
    pub fn target(&self) -> S3Target {
        self.target.clone()
    }

    /// An adapter on the production transport, as a desktop would have it.
    pub fn remote(&self) -> S3Remote<'_> {
        S3Remote::new(
            self.target(),
            &self.prefix,
            &self.credentials,
            &self.transport,
        )
        .expect("the test prefix is valid")
    }

    fn client(&self) -> S3Client<'_> {
        S3Client::new(self.target(), &self.credentials, &self.admin)
    }

    /// Creates the bucket if it is not there and turns Versioning on if it is off, which is what
    /// the adapter requires of every bucket (ADR 0018). An existing bucket is left as it is, so
    /// the tests also run against a bucket on AWS that the profile may not create or configure.
    fn prepare_bucket(&self) {
        let client = self.client();
        let head = S3Call {
            method: "HEAD",
            key: "",
            query: &[],
            headers: &[],
            body: &[],
        };
        let exists = matches!(client.send(&head), Ok(response) if response.status < 300);
        if !exists {
            // Outside us-east-1, AWS needs the bucket's region in the request.
            let region = self.target.region();
            let configuration = format!(
                r#"<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>{region}</LocationConstraint></CreateBucketConfiguration>"#
            );
            let body: &[u8] = if region == "us-east-1" {
                &[]
            } else {
                configuration.as_bytes()
            };
            let created = client
                .send(&S3Call {
                    method: "PUT",
                    key: "",
                    query: &[],
                    headers: &[],
                    body,
                })
                .unwrap();
            let owned = created.status < 300 || created.status == 409;
            assert!(owned, "the bucket cannot be created: {created:?}");
        }
        let current = self.expect(&S3Call::get("", &[("versioning", "")]));
        if String::from_utf8_lossy(&current.body).contains("<Status>Enabled</Status>") {
            return;
        }
        let versioning = br#"<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>"#;
        let enabled = client
            .send(&S3Call {
                method: "PUT",
                key: "",
                query: &[("versioning", "")],
                headers: &[],
                body: versioning,
            })
            .unwrap();
        assert!(
            enabled.status < 300,
            "Versioning cannot be enabled: {enabled:?}"
        );
    }

    /// The test's own request, which must succeed. Returns the response.
    fn expect(&self, call: &S3Call<'_>) -> S3Response {
        let response = self.client().send(call).unwrap();
        assert!(
            response.status < 300,
            "{} failed: {response:?}",
            call.method
        );
        response
    }

    /// Puts an object the way another tool would (no ticketd metadata); returns its version.
    pub fn put_foreign(&self, key: &str, bytes: &[u8]) -> String {
        let response = self.expect(&S3Call {
            method: "PUT",
            key,
            query: &[],
            headers: &[],
            body: bytes,
        });
        response
            .header("x-amz-version-id")
            .expect("a versioned bucket names the version")
            .to_owned()
    }

    /// Deletes the object, which on a versioned bucket adds a delete marker; returns its version.
    pub fn delete(&self, key: &str) -> String {
        let response = self.expect(&S3Call {
            method: "DELETE",
            key,
            query: &[],
            headers: &[],
            body: &[],
        });
        response
            .header("x-amz-version-id")
            .expect("a delete marker has a version")
            .to_owned()
    }

    /// Removes one version for good (a delete marker too).
    pub fn remove_version(&self, key: &str, version: &str) {
        self.expect(&S3Call {
            method: "DELETE",
            key,
            query: &[("versionId", version)],
            headers: &[],
            body: &[],
        });
    }

    /// How many multipart uploads are begun and not yet completed or aborted under `prefix`.
    pub fn pending_uploads(&self, prefix: &str) -> usize {
        let response = self.expect(&S3Call::get("", &[("uploads", ""), ("prefix", prefix)]));
        String::from_utf8_lossy(&response.body)
            .matches("<UploadId>")
            .count()
    }

    /// The headers of the object's current version.
    pub fn head(&self, key: &str) -> S3Response {
        self.expect(&S3Call {
            method: "HEAD",
            key,
            query: &[],
            headers: &[],
            body: &[],
        })
    }
}
