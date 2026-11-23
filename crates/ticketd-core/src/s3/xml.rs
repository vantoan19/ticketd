//! The few XML answers S3 gives: errors and the two listings.
use quick_xml::Reader;
use quick_xml::events::Event;

/// One S3 error body: `<Error><Code>…</Code><Message>…</Message></Error>`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// What the elements of an answer say, in document order.
enum Item {
    Open(String),
    Close(String),
    /// `(parent, name, text)` of an element that holds text.
    Text(String, String, String),
}

fn items(xml: &[u8]) -> Option<Vec<Item>> {
    let text = std::str::from_utf8(xml).ok()?;
    let mut reader = Reader::from_str(text);
    let mut path: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut content = String::new();
    loop {
        match reader.read_event().ok()? {
            Event::Start(start) => {
                let name = start.local_name().as_ref().to_owned();
                out.push(Item::Open(name.clone()));
                path.push(name);
                content.clear();
            }
            Event::Text(text) => content.push_str(&text.xml10_content()),
            Event::GeneralRef(reference) => match reference.resolve_char_ref().ok()? {
                Some(character) => content.push(character),
                None => content.push_str(entity(&reference)?),
            },
            Event::End(_) => {
                let name = path.pop()?;
                // Whitespace between child elements is layout, not a value.
                if !content.trim().is_empty() {
                    let parent = path.last().cloned().unwrap_or_default();
                    out.push(Item::Text(parent, name.clone(), content.clone()));
                }
                content.clear();
                out.push(Item::Close(name));
            }
            Event::Empty(empty) => {
                let name = empty.local_name().as_ref().to_owned();
                out.push(Item::Open(name.clone()));
                out.push(Item::Close(name));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    path.is_empty().then_some(out)
}

/// The five entities XML predefines; character references are resolved by the reader.
fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "quot" => "\"",
        "amp" => "&",
        "apos" => "'",
        "lt" => "<",
        "gt" => ">",
        _ => return None,
    })
}

pub(crate) fn error_body(xml: &[u8]) -> Option<ErrorBody> {
    let mut error = ErrorBody::default();
    let mut seen = false;
    for item in items(xml)? {
        if let Item::Text(parent, name, text) = item
            && parent == "Error"
        {
            seen = true;
            match name.as_str() {
                "Code" => error.code = text,
                "Message" => error.message = text,
                _ => {}
            }
        }
    }
    seen.then_some(error)
}

/// One entry of ListObjectVersions, in the order S3 listed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Listed {
    pub key: String,
    pub version_id: String,
    pub modified: String,
    /// What a delete marker does not have: its content.
    pub content: Option<Content>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Content {
    pub etag: String,
    pub size: u64,
}

impl Listed {
    pub(crate) fn is_delete_marker(&self) -> bool {
        self.content.is_none()
    }
}

#[derive(Debug, Default)]
pub(crate) struct VersionsPage {
    pub entries: Vec<Listed>,
    pub truncated: bool,
    pub next_key_marker: Option<String>,
    pub next_version_marker: Option<String>,
}

/// Versions and delete markers arrive as two kinds of element, interleaved in the order the
/// document gives them: newest first within a key.
pub(crate) fn versions_page(xml: &[u8]) -> Option<VersionsPage> {
    #[derive(Default)]
    struct Draft {
        key: String,
        version_id: String,
        modified: String,
        etag: String,
        size: Option<u64>,
    }
    let mut page = VersionsPage::default();
    let mut open: Option<Draft> = None;
    for item in items(xml)? {
        match item {
            Item::Open(name) if name == "Version" || name == "DeleteMarker" => {
                open = Some(Draft::default());
            }
            Item::Close(name) if name == "Version" || name == "DeleteMarker" => {
                let draft = open.take()?;
                if draft.key.is_empty() || draft.version_id.is_empty() {
                    return None;
                }
                let content = if name == "Version" {
                    Some(Content {
                        etag: draft.etag,
                        size: draft.size?,
                    })
                } else {
                    None
                };
                page.entries.push(Listed {
                    key: draft.key,
                    version_id: draft.version_id,
                    modified: draft.modified,
                    content,
                });
            }
            Item::Text(parent, name, text) => match (parent.as_str(), name.as_str()) {
                ("Version" | "DeleteMarker", field) => {
                    if let Some(draft) = open.as_mut() {
                        match field {
                            "Key" => draft.key = text,
                            "VersionId" => draft.version_id = text,
                            "LastModified" => draft.modified = text,
                            "ETag" => draft.etag = text,
                            "Size" => draft.size = Some(text.parse().ok()?),
                            _ => {}
                        }
                    }
                }
                ("ListVersionsResult", "IsTruncated") => page.truncated = text == "true",
                ("ListVersionsResult", "NextKeyMarker") => page.next_key_marker = Some(text),
                ("ListVersionsResult", "NextVersionIdMarker") => {
                    page.next_version_marker = Some(text);
                }
                _ => {}
            },
            _ => {}
        }
    }
    if page.truncated && page.next_key_marker.is_none() {
        return None;
    }
    Some(page)
}

#[derive(Debug, Default)]
pub(crate) struct PrefixesPage {
    pub prefixes: Vec<String>,
    pub next_token: Option<String>,
}

/// ListObjectsV2 with a delimiter: the common prefixes, which are the folders.
pub(crate) fn prefixes_page(xml: &[u8]) -> Option<PrefixesPage> {
    let mut page = PrefixesPage::default();
    let mut truncated = false;
    for item in items(xml)? {
        if let Item::Text(parent, name, text) = item {
            match (parent.as_str(), name.as_str()) {
                ("CommonPrefixes", "Prefix") => page.prefixes.push(text),
                ("ListBucketResult", "IsTruncated") => truncated = text == "true",
                ("ListBucketResult", "NextContinuationToken") => page.next_token = Some(text),
                _ => {}
            }
        }
    }
    if truncated && page.next_token.is_none() {
        return None;
    }
    if !truncated {
        page.next_token = None;
    }
    Some(page)
}

/// The id InitiateMultipartUpload answers with.
pub(crate) fn created_upload(xml: &[u8]) -> Option<String> {
    items(xml)?.into_iter().find_map(|item| match item {
        Item::Text(parent, name, text)
            if parent == "InitiateMultipartUploadResult" && name == "UploadId" =>
        {
            Some(text)
        }
        _ => None,
    })
}

/// One page of ListMultipartUploads: the uploads begun and not yet completed or aborted.
#[derive(Debug, Default)]
pub(crate) struct UploadsPage {
    /// `(key, upload id)`, oldest first within a key.
    pub uploads: Vec<(String, String)>,
    pub truncated: bool,
    pub next_key_marker: Option<String>,
    pub next_upload_marker: Option<String>,
}

pub(crate) fn uploads_page(xml: &[u8]) -> Option<UploadsPage> {
    let mut page = UploadsPage::default();
    let mut open: Option<(String, String)> = None;
    for item in items(xml)? {
        match item {
            Item::Open(name) if name == "Upload" => open = Some(Default::default()),
            Item::Close(name) if name == "Upload" => {
                let (key, id) = open.take()?;
                if key.is_empty() || id.is_empty() {
                    return None;
                }
                page.uploads.push((key, id));
            }
            Item::Text(parent, name, text) => match (parent.as_str(), name.as_str()) {
                ("Upload", "Key") => open.as_mut()?.0 = text,
                ("Upload", "UploadId") => open.as_mut()?.1 = text,
                ("ListMultipartUploadsResult", "IsTruncated") => page.truncated = text == "true",
                ("ListMultipartUploadsResult", "NextKeyMarker") => {
                    page.next_key_marker = Some(text);
                }
                ("ListMultipartUploadsResult", "NextUploadIdMarker") => {
                    page.next_upload_marker = Some(text);
                }
                _ => {}
            },
            _ => {}
        }
    }
    if page.truncated && page.next_key_marker.is_none() {
        return None;
    }
    Some(page)
}

/// A part an upload already holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ListedPart {
    pub number: u32,
    pub size: u64,
    pub etag: String,
    /// The part's SHA-256 as base64, when the upload was created with that checksum.
    pub checksum: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct PartsPage {
    pub parts: Vec<ListedPart>,
    pub truncated: bool,
    pub next_marker: Option<String>,
}

pub(crate) fn parts_page(xml: &[u8]) -> Option<PartsPage> {
    #[derive(Default)]
    struct Draft {
        number: Option<u32>,
        size: Option<u64>,
        etag: String,
        checksum: Option<String>,
    }
    let mut page = PartsPage::default();
    let mut open: Option<Draft> = None;
    for item in items(xml)? {
        match item {
            Item::Open(name) if name == "Part" => open = Some(Draft::default()),
            Item::Close(name) if name == "Part" => {
                let draft = open.take()?;
                page.parts.push(ListedPart {
                    number: draft.number?,
                    size: draft.size?,
                    etag: draft.etag,
                    checksum: draft.checksum,
                });
            }
            Item::Text(parent, name, text) => match (parent.as_str(), name.as_str()) {
                ("Part", field) => {
                    if let Some(draft) = open.as_mut() {
                        match field {
                            "PartNumber" => draft.number = Some(text.parse().ok()?),
                            "Size" => draft.size = Some(text.parse().ok()?),
                            "ETag" => draft.etag = text,
                            "ChecksumSHA256" => draft.checksum = Some(text),
                            _ => {}
                        }
                    }
                }
                ("ListPartsResult", "IsTruncated") => page.truncated = text == "true",
                ("ListPartsResult", "NextPartNumberMarker") => page.next_marker = Some(text),
                _ => {}
            },
            _ => {}
        }
    }
    if page.truncated && page.next_marker.is_none() {
        return None;
    }
    Some(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_body_has_its_code_and_message() {
        let body = b"<?xml version=\"1.0\"?><Error><Code>SlowDown</Code><Message>Slow &amp; steady</Message><RequestId>1</RequestId></Error>";
        assert_eq!(
            error_body(body),
            Some(ErrorBody {
                code: "SlowDown".into(),
                message: "Slow & steady".into()
            })
        );
        assert_eq!(error_body(b"<html>nope</html>"), None);
        assert_eq!(error_body(b""), None);
    }

    #[test]
    fn versions_keep_the_document_order_with_delete_markers_between_them() {
        let body = br#"<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>b</Name><IsTruncated>true</IsTruncated>
            <NextKeyMarker>a/2</NextKeyMarker><NextVersionIdMarker>v3</NextVersionIdMarker>
            <Version><Key>a/1</Key><VersionId>v4</VersionId><IsLatest>true</IsLatest>
              <LastModified>2026-11-11T00:00:04.000Z</LastModified><ETag>&quot;e4&quot;</ETag><Size>7</Size></Version>
            <DeleteMarker><Key>a/1</Key><VersionId>v3</VersionId><IsLatest>false</IsLatest>
              <LastModified>2026-11-11T00:00:03.000Z</LastModified></DeleteMarker>
            <Version><Key>a/1</Key><VersionId>v1</VersionId><LastModified>2026-11-11T00:00:01.000Z</LastModified>
              <ETag>&quot;e1&quot;</ETag><Size>3</Size></Version>
        </ListVersionsResult>"#;
        let page = versions_page(body).unwrap();
        assert!(page.truncated);
        assert_eq!(page.next_key_marker.as_deref(), Some("a/2"));
        assert_eq!(page.next_version_marker.as_deref(), Some("v3"));
        let seen: Vec<(&str, bool)> = page
            .entries
            .iter()
            .map(|e| (e.version_id.as_str(), e.is_delete_marker()))
            .collect();
        assert_eq!(seen, [("v4", false), ("v3", true), ("v1", false)]);
        assert_eq!(
            page.entries[0].content,
            Some(Content {
                etag: "\"e4\"".into(),
                size: 7
            })
        );
    }

    #[test]
    fn the_answers_about_uploads_in_parts_are_read() {
        let created = b"<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>u1</UploadId></InitiateMultipartUploadResult>";
        assert_eq!(created_upload(created).as_deref(), Some("u1"));

        let uploads = br#"<ListMultipartUploadsResult><IsTruncated>true</IsTruncated>
            <NextKeyMarker>k</NextKeyMarker><NextUploadIdMarker>u2</NextUploadIdMarker>
            <Upload><Key>k</Key><UploadId>u1</UploadId><Initiator><ID>x</ID></Initiator></Upload>
            <Upload><Key>k</Key><UploadId>u2</UploadId></Upload></ListMultipartUploadsResult>"#;
        let page = uploads_page(uploads).unwrap();
        assert_eq!(
            page.uploads,
            [("k".into(), "u1".into()), ("k".into(), "u2".into())]
        );
        assert!(page.truncated);
        assert_eq!(page.next_upload_marker.as_deref(), Some("u2"));

        let parts = br#"<ListPartsResult><IsTruncated>false</IsTruncated>
            <Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>5</Size><ChecksumSHA256>c1=</ChecksumSHA256></Part>
            <Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag><Size>3</Size></Part></ListPartsResult>"#;
        let page = parts_page(parts).unwrap();
        assert_eq!(page.parts.len(), 2);
        assert_eq!(page.parts[0].etag, "\"e1\"");
        assert_eq!(page.parts[0].checksum.as_deref(), Some("c1="));
        assert_eq!(page.parts[1].checksum, None);
    }

    #[test]
    fn a_truncated_page_without_markers_is_unreadable() {
        let body = b"<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>";
        assert!(versions_page(body).is_none());
    }

    #[test]
    fn folders_are_the_common_prefixes() {
        let body = br#"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>
            <Contents><Key>ticketd/x</Key></Contents>
            <CommonPrefixes><Prefix>ticketd/one/</Prefix></CommonPrefixes>
            <CommonPrefixes><Prefix>ticketd/two/</Prefix></CommonPrefixes></ListBucketResult>"#;
        let page = prefixes_page(body).unwrap();
        assert_eq!(page.prefixes, ["ticketd/one/", "ticketd/two/"]);
        assert_eq!(page.next_token.as_deref(), Some("t1"));
    }
}
