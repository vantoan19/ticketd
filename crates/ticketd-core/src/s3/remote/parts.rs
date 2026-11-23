//! A file over the single-part limit uploads as an S3 multipart upload.
//!
//! - The upload is created with ticketd's SHA-256 of the whole file as metadata, because S3
//!   only has a composite checksum for parts. Download checks the file against it.
//! - Every part carries its own SHA-256 (the upload is created with that checksum algorithm),
//!   so S3 verifies each part as it arrives and `ListParts` later shows which parts are ours.
//! - Nothing is kept on the desktop. An upload cut short by going offline, quitting or a crash
//!   is found again with `ListMultipartUploads` and `ListParts`, and only the missing parts are
//!   sent. An upload whose parts are not this file's is someone else's or stale: it is aborted,
//!   because an upload that is neither completed nor aborted is billed for its parts.
//! - It completes with the same condition a single write has (`If-None-Match: *` for an
//!   Attachment, which is written once), so S3 refuses it if another desktop finished first.
use super::*;
use crate::s3::S3Response;
use crate::s3::xml::{ListedPart, created_upload, parts_page, uploads_page};

const MIB: u64 = 1024 * 1024;
/// The size of a part unless the file needs bigger ones to fit in [`MAX_PARTS`].
pub(super) const PART_SIZE: u64 = 8 * MIB;
/// S3 refuses a part smaller than this, except the last.
pub(super) const MIN_PART: u64 = 5 * MIB;
/// S3 takes at most this many parts in one upload.
const MAX_PARTS: u64 = 10_000;

/// The size of each part but the last. It follows from the file's size and the adapter's
/// setting alone, so a restarted upload cuts the file the same way.
fn part_size_for(size: u64, base: u64) -> u64 {
    base.max(size.div_ceil(MAX_PARTS).next_multiple_of(MIB))
}

struct Planned {
    number: u32,
    offset: u64,
    len: u64,
    /// The part's SHA-256, as base64 like S3 writes it.
    checksum: String,
}

/// How the file is cut, and its SHA-256, before anything is sent.
struct Plan {
    hash: String,
    parts: Vec<Planned>,
}

fn changed() -> RemoteError {
    RemoteError::Other("the file changed while it was being uploaded".into())
}

/// Reads the file once, in pieces, for its SHA-256 and each part's.
fn plan(content: &mut dyn RemoteContent, size: u64, part_size: u64) -> Result<Plan, RemoteError> {
    let unreadable = |_| RemoteError::Other("cannot read the content to upload".into());
    let part_size = part_size_for(size, part_size);
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    let mut whole = Sha256::new();
    let mut parts = Vec::new();
    let mut buffer = vec![0_u8; MIB as usize];
    let mut offset = 0;
    while offset < size {
        let len = part_size.min(size - offset);
        let mut part = Sha256::new();
        let mut left = len;
        while left > 0 {
            let chunk = &mut buffer[..left.min(MIB) as usize];
            content.read_exact(chunk).map_err(|_| changed())?;
            whole.update(&*chunk);
            part.update(&*chunk);
            left -= chunk.len() as u64;
        }
        parts.push(Planned {
            number: u32::try_from(parts.len() + 1).map_err(|_| changed())?,
            offset,
            len,
            checksum: STANDARD.encode(part.finalize()),
        });
        offset += len;
    }
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    Ok(Plan {
        hash: hex(&whole.finalize()),
        parts,
    })
}

/// Where the parts of an upload stand.
enum Upload {
    /// Every part of the file is in the upload; their ETags in order.
    Ready { id: String, etags: Vec<String> },
    /// S3 no longer has the upload (aborted by someone, or expired): begin again.
    Gone,
}

/// What a 200 answer to a completion says. S3 can answer 200 and then fail while it assembles
/// the file, and say so only in the body.
fn completion(response: S3Response) -> Result<S3Response, RemoteError> {
    if response.status != 200 {
        return Ok(response);
    }
    if let Some(error) = crate::s3::client::error_of(&response) {
        let status = match error.code.as_str() {
            "PreconditionFailed" => 412,
            "ConditionalRequestConflict" => 409,
            "NoSuchUpload" => 404,
            "InternalError" => 500,
            "SlowDown" | "ServiceUnavailable" => 503,
            _ => 400,
        };
        return Ok(S3Response { status, ..response });
    }
    if !String::from_utf8_lossy(&response.body).contains("CompleteMultipartUploadResult") {
        return Err(unreadable());
    }
    Ok(response)
}

fn completion_body(plan: &Plan, etags: &[String]) -> String {
    let mut body = String::from("<CompleteMultipartUpload>");
    for (planned, etag) in plan.parts.iter().zip(etags) {
        body.push_str(&format!(
            "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag><ChecksumSHA256>{}</ChecksumSHA256></Part>",
            planned.number,
            etag.replace('&', "&amp;").replace('<', "&lt;"),
            planned.checksum
        ));
    }
    body.push_str("</CompleteMultipartUpload>");
    body
}

impl S3Remote<'_> {
    pub(super) fn write_in_parts(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
        size: u64,
    ) -> Result<RemoteFile, RemoteError> {
        let plan = plan(content, size, self.part_size)?;
        self.require_folder(folder)?;
        let object = self.object_key(folder, key);

        for attempt in 0..WRITE_ATTEMPTS {
            let lookup = self.lookup(folder, key)?;
            let stored = lookup.stored();
            if let Some(stored) = &stored
                && self.holds(&object, stored, size, &plan.hash)?
            {
                // Another desktop (or this one, whose answer was lost) finished the file.
                self.abort_uploads(&object);
                return Ok(stored.file.clone());
            }
            let condition = match condition_for(&stored, expected) {
                Ok(condition) => condition,
                Err(error) => {
                    self.abort_uploads(&object);
                    return Err(error);
                }
            };
            let Upload::Ready { id, etags } =
                self.upload_parts(&object, key, name, &plan, content)?
            else {
                continue;
            };

            let headers = [condition];
            let response = self.client.send(&S3Call {
                method: "POST",
                key: &object,
                query: &[("uploadId", id.as_str())],
                headers: &headers,
                body: completion_body(&plan, &etags).as_bytes(),
            })?;
            let response = completion(response)?;
            let code = crate::s3::client::error_of(&response).map(|error| error.code);
            match response.status {
                200 => {
                    let version = response
                        .header("x-amz-version-id")
                        .filter(|version| valid_version(version))
                        .ok_or_else(|| {
                            RemoteError::Other(
                                "S3 stored the file without a version; turn on Versioning for the bucket"
                                    .into(),
                            )
                        })?;
                    let (file_id, created) = lookup.identity();
                    return Ok(RemoteFile {
                        key: key.clone(),
                        name: file_name(key),
                        version: version.to_owned(),
                        size,
                        file_id,
                        created,
                    });
                }
                // Another device wrote since the lookup; read what is stored now. The upload
                // keeps its parts for the next lookup, which ends it one way or the other.
                412 => {}
                // S3 could not finish the upload because of another write to the key. Its parts
                // are not trusted after that, so the upload starts over.
                409 => {
                    self.abort(&object, &id);
                    self.client.wait(Duration::from_millis(100 << attempt));
                }
                404 if code.as_deref() == Some("NoSuchUpload") => {}
                // The file went away since the lookup.
                404 if stored.is_some() && condition_is_if_match(&headers) => {
                    self.abort_uploads(&object);
                    return Err(RemoteError::PreconditionFailed { current: None });
                }
                _ => {
                    let error = refusal(&response);
                    return Err(if error == RemoteError::FolderMissing {
                        self.forget(folder)
                    } else {
                        error
                    });
                }
            }
        }
        Err(RemoteError::Other(
            "S3 kept refusing the upload because the file kept changing; it will be retried".into(),
        ))
    }

    /// Finds this file's upload in progress, or begins one, and sends the parts it lacks.
    fn upload_parts(
        &self,
        object: &str,
        key: &RemoteKey,
        name: &str,
        plan: &Plan,
        content: &mut dyn RemoteContent,
    ) -> Result<Upload, RemoteError> {
        let mut chosen: Option<(String, Vec<Option<String>>)> = None;
        for id in self.uploads_of(object)? {
            let resumed = if chosen.is_none() {
                self.resumable(object, &id, plan)?
            } else {
                None
            };
            match resumed {
                Some(etags) => chosen = Some((id, etags)),
                None => self.abort(object, &id),
            }
        }
        let (id, mut etags) = match chosen {
            Some(chosen) => chosen,
            None => (
                self.begin(object, key, name, plan)?,
                vec![None; plan.parts.len()],
            ),
        };
        for (planned, etag) in plan.parts.iter().zip(etags.iter_mut()) {
            if etag.is_some() {
                continue;
            }
            let mut bytes = vec![0_u8; usize::try_from(planned.len).map_err(|_| changed())?];
            content
                .seek(SeekFrom::Start(planned.offset))
                .and_then(|_| content.read_exact(&mut bytes))
                .map_err(|_| changed())?;
            let number = planned.number.to_string();
            let headers = [("x-amz-checksum-sha256", planned.checksum.clone())];
            let response = self.client.send(&S3Call {
                method: "PUT",
                key: object,
                query: &[("partNumber", number.as_str()), ("uploadId", id.as_str())],
                headers: &headers,
                body: &bytes,
            })?;
            let code = crate::s3::client::error_of(&response).map(|error| error.code);
            match (response.status, code.as_deref()) {
                (200, _) => {
                    *etag = Some(response.header("etag").ok_or_else(unreadable)?.to_owned());
                }
                (404, Some("NoSuchUpload")) => return Ok(Upload::Gone),
                (400, Some("BadDigest")) => return Err(changed()),
                _ => return Err(refusal(&response)),
            }
        }
        // The file was read once more while it was sent; leave it ready for the next write.
        content
            .seek(SeekFrom::Start(0))
            .map_err(|_| RemoteError::Other("cannot read the content to upload".into()))?;
        Ok(Upload::Ready {
            id,
            etags: etags.into_iter().flatten().collect(),
        })
    }

    /// Creates the upload, with the metadata the finished file keeps.
    fn begin(
        &self,
        object: &str,
        key: &RemoteKey,
        name: &str,
        plan: &Plan,
    ) -> Result<String, RemoteError> {
        let headers = [
            ("content-type", content_type(key.kind).to_owned()),
            (
                "content-disposition",
                format!("attachment; filename*=UTF-8''{}", encode(name)),
            ),
            (HASH_METADATA, plan.hash.clone()),
            ("x-amz-checksum-algorithm", "SHA256".to_owned()),
        ];
        let response = self.client.send(&S3Call {
            method: "POST",
            key: object,
            query: &[("uploads", "")],
            headers: &headers,
            body: &[],
        })?;
        if response.status != 200 {
            return Err(refusal(&response));
        }
        created_upload(&response.body).ok_or_else(unreadable)
    }

    /// The ETag of each part of `plan` that upload `id` already holds, if every part it holds
    /// is this file's. An upload with no parts cannot be told from another file's (S3 does not
    /// say what it was created with), so it is not resumed.
    fn resumable(
        &self,
        object: &str,
        id: &str,
        plan: &Plan,
    ) -> Result<Option<Vec<Option<String>>>, RemoteError> {
        let Some(held) = self.parts_of(object, id)? else {
            return Ok(None);
        };
        if held.is_empty() {
            return Ok(None);
        }
        let mut etags = vec![None; plan.parts.len()];
        for part in held {
            let ours = usize::try_from(part.number)
                .ok()
                .and_then(|number| number.checked_sub(1))
                .and_then(|index| Some((index, plan.parts.get(index)?)))
                .filter(|(_, planned)| {
                    planned.len == part.size && part.checksum.as_deref() == Some(&planned.checksum)
                });
            let Some((index, _)) = ours else {
                return Ok(None);
            };
            etags[index] = Some(part.etag);
        }
        Ok(Some(etags))
    }

    /// The ids of the uploads in progress for exactly `object`, oldest first.
    fn uploads_of(&self, object: &str) -> Result<Vec<String>, RemoteError> {
        let mut found = Vec::new();
        let mut markers: Option<(String, Option<String>)> = None;
        loop {
            let mut query = vec![("uploads", ""), ("prefix", object)];
            if let Some((key, id)) = &markers {
                query.push(("key-marker", key));
                if let Some(id) = id {
                    query.push(("upload-id-marker", id));
                }
            }
            let response = self.client.send(&S3Call::get("", &query))?;
            if response.status != 200 {
                return Err(refusal(&response));
            }
            let page = uploads_page(&response.body).ok_or_else(unreadable)?;
            found.extend(
                page.uploads
                    .into_iter()
                    .filter(|(key, _)| key == object)
                    .map(|(_, id)| id),
            );
            if !page.truncated {
                return Ok(found);
            }
            markers = Some((
                page.next_key_marker.ok_or_else(unreadable)?,
                page.next_upload_marker,
            ));
        }
    }

    /// The parts upload `id` holds, or `None` when S3 has no such upload.
    fn parts_of(&self, object: &str, id: &str) -> Result<Option<Vec<ListedPart>>, RemoteError> {
        let mut found = Vec::new();
        let mut marker: Option<String> = None;
        loop {
            let mut query = vec![("uploadId", id)];
            if let Some(marker) = &marker {
                query.push(("part-number-marker", marker));
            }
            let response = self.client.send(&S3Call::get(object, &query))?;
            match response.status {
                200 => {}
                404 if crate::s3::client::error_of(&response)
                    .is_some_and(|error| error.code == "NoSuchUpload") =>
                {
                    return Ok(None);
                }
                _ => return Err(refusal(&response)),
            }
            let page = parts_page(&response.body).ok_or_else(unreadable)?;
            found.extend(page.parts);
            if !page.truncated {
                return Ok(Some(found));
            }
            marker = Some(page.next_marker.ok_or_else(unreadable)?);
        }
    }

    /// Ends every upload in progress for `object`, so none is left billing for its parts.
    /// The write that calls this already has its answer, so a failure here is only logged.
    fn abort_uploads(&self, object: &str) {
        match self.uploads_of(object) {
            Ok(ids) => {
                for id in ids {
                    self.abort(object, &id);
                }
            }
            Err(error) => tracing::warn!(%error, "S3 uploads could not be listed to abort them"),
        }
    }

    /// Aborts one upload. One that is already gone is as good as aborted.
    fn abort(&self, object: &str, id: &str) {
        let outcome = self.client.send(&S3Call {
            method: "DELETE",
            key: object,
            query: &[("uploadId", id)],
            headers: &[],
            body: &[],
        });
        match outcome {
            Ok(response) if response.status < 400 || response.status == 404 => {}
            Ok(response) => {
                tracing::warn!(error = %refusal(&response), "S3 upload could not be aborted");
            }
            Err(error) => tracing::warn!(%error, "S3 upload could not be aborted"),
        }
    }
}
