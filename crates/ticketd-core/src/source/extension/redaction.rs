use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use aho_corasick::AhoCorasick;
use base64::{Engine as _, engine::general_purpose};
use serde_json::Value;

const MARKER: &[u8] = b"[redacted]";

#[derive(Clone, Default)]
pub(super) struct Redactions(Arc<Mutex<Patterns>>);

#[derive(Default)]
struct Patterns {
    raw: BTreeSet<Vec<u8>>,
    values: BTreeSet<Vec<u8>>,
    matcher: Option<AhoCorasick>,
    longest: usize,
}

impl Redactions {
    pub(super) fn register<'a>(&self, secrets: impl IntoIterator<Item = &'a str>) {
        let mut patterns = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let before = patterns.values.len();
        let lower_percent = regex::Regex::new("%[0-9A-F]{2}");
        for secret in secrets {
            if secret.is_empty() || !patterns.raw.insert(secret.as_bytes().to_vec()) {
                continue;
            }
            patterns.values.insert(secret.as_bytes().to_vec());
            let quoted = Value::String(secret.to_owned()).to_string();
            patterns
                .values
                .insert(quoted.as_bytes()[1..quoted.len() - 1].to_vec());
            let url: String = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect();
            patterns.values.insert(url.as_bytes().to_vec());
            patterns.values.insert(url.replace('+', "%20").into_bytes());
            if let Ok(lower_percent) = &lower_percent {
                patterns.values.insert(
                    lower_percent
                        .replace_all(&url, |matched: &regex::Captures<'_>| {
                            matched[0].to_ascii_lowercase()
                        })
                        .into_owned()
                        .into_bytes(),
                );
            }
            for engine in [
                general_purpose::STANDARD,
                general_purpose::STANDARD_NO_PAD,
                general_purpose::URL_SAFE,
                general_purpose::URL_SAFE_NO_PAD,
            ] {
                patterns.values.insert(engine.encode(secret).into_bytes());
            }
        }
        if patterns.values.len() != before {
            patterns.longest = patterns.values.iter().map(Vec::len).max().unwrap_or(0);
            patterns.matcher = AhoCorasick::new(&patterns.values).ok();
        }
    }

    pub(super) fn bytes(&self, input: &[u8]) -> Vec<u8> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(input, input.len(), 0)
            .0
    }

    pub(super) fn text(&self, input: &str) -> String {
        String::from_utf8_lossy(&self.bytes(input.as_bytes())).into_owned()
    }

    pub(super) fn contains_secret(&self, value: &Value) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_value(value)
    }

    pub(super) fn fields(&self, fields: &mut [super::FieldIssue]) {
        for field in fields {
            field.message = self.text(&field.message);
            if let Some(key) = &mut field.field {
                *key = self.text(key);
            }
        }
    }

    pub(super) fn stream(&self) -> RedactedStream {
        RedactedStream {
            redactions: self.clone(),
            pending: Vec::new(),
            covered: 0,
        }
    }
}

impl Patterns {
    fn contains_value(&self, value: &Value) -> bool {
        match value {
            Value::String(value) => self.contains(value, true),
            Value::Array(values) => values.iter().any(|value| self.contains_value(value)),
            Value::Object(values) => values
                .iter()
                .any(|(key, value)| self.contains(key, false) || self.contains_value(value)),
            _ => false,
        }
    }

    fn contains(&self, input: &str, embedded_raw: bool) -> bool {
        let Some(matcher) = &self.matcher else {
            return !self.values.is_empty();
        };
        let bytes = input.as_bytes();
        matcher.find_overlapping_iter(bytes).any(|matched| {
            let word = |byte: Option<&u8>| byte.is_some_and(u8::is_ascii_alphanumeric);
            // Short encodings and single-byte credentials often occur inside
            // unrelated words. Longer raw credentials in values are checked
            // even when embedded. Keep protocol keys on the boundary rule.
            matched.len() >= 6
                || (embedded_raw
                    && matched.len() > 1
                    && self.raw.contains(&bytes[matched.start()..matched.end()]))
                || (!word(
                    matched
                        .start()
                        .checked_sub(1)
                        .and_then(|index| bytes.get(index)),
                ) && !word(bytes.get(matched.end())))
        })
    }

    /// Release only bytes for which every possible match has been seen.
    /// Return the length of the already-redacted prefix in the retained tail.
    fn replace(&self, input: &[u8], release: usize, covered: usize) -> (Vec<u8>, usize) {
        let Some(matcher) = &self.matcher else {
            return if self.values.is_empty() || release == 0 {
                (input[..release].to_vec(), covered.saturating_sub(release))
            } else {
                (MARKER.to_vec(), input.len() - release)
            };
        };
        let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
        if covered != 0 {
            spans.push(0..covered);
        }
        // Standard Aho-Corasick reports matches in end order. Coalesce their
        // union, including overlapping matches that start at different bytes.
        for matched in matcher.find_overlapping_iter(input) {
            let mut start = matched.start();
            while spans.last().is_some_and(|span| start < span.end) {
                start = start.min(spans.pop().map_or(start, |span| span.start));
            }
            spans.push(start..matched.end().max(covered));
        }
        let mut output = Vec::new();
        let mut start = 0;
        for span in spans.into_iter().take_while(|span| span.start < release) {
            output.extend_from_slice(&input[start..span.start]);
            if span.start != 0 || covered == 0 {
                output.extend_from_slice(MARKER);
            }
            start = span.end;
        }
        if start < release {
            output.extend_from_slice(&input[start..release]);
        }
        (output, start.max(covered).saturating_sub(release))
    }
}

/// Holds back enough bytes to replace a secret split across pipe reads.
pub(super) struct RedactedStream {
    redactions: Redactions,
    pending: Vec<u8>,
    covered: usize,
}

impl RedactedStream {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let patterns = self
            .redactions
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let release = self
            .pending
            .len()
            .saturating_sub(patterns.longest.saturating_sub(1));
        let (result, covered) = patterns.replace(&self.pending, release, self.covered);
        self.covered = covered;
        self.pending.drain(..release);
        result
    }

    pub(super) fn finish(&mut self) -> Vec<u8> {
        let pending = std::mem::take(&mut self.pending);
        let covered = std::mem::take(&mut self.covered);
        self.redactions
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(&pending, pending.len(), covered)
            .0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expanding_a_raw_credential_does_not_depend_on_registration_order() {
        for values in [["example", "ZXhhbXBsZQ=="], ["ZXhhbXBsZQ==", "example"]] {
            let secrets = Redactions::default();
            for value in values {
                secrets.register([value]);
            }
            assert_eq!(secrets.text("WlhoaGJYQnNaUT09"), "[redacted]");
        }
    }

    #[test]
    fn expanded_matches_cover_the_whole_overlap_across_stream_chunks() {
        let secrets = Redactions::default();
        secrets.register(["abcdefgh", "hijklmnop", "separate"]);
        let input = b"before abcdefghijklmnop after separate";
        let expected = b"before [redacted] after [redacted]";
        assert_eq!(secrets.bytes(input), expected);
        for split in 0..input.len() {
            let mut stream = secrets.stream();
            let result = [
                stream.push(&input[..split]),
                stream.push(&input[split..]),
                stream.finish(),
            ]
            .concat();
            assert_eq!(result, expected);
        }
    }

    #[test]
    fn detects_short_raw_values_inside_a_result_and_keeps_single_byte_boundaries() {
        let secrets = Redactions::default();
        secrets.register(["mv3k2", "x"]);
        assert!(secrets.contains_secret(&serde_json::json!({"title": "prefixmv3k2suffix"})));
        assert!(secrets.contains_secret(&serde_json::json!(["x"])));
        assert!(!secrets.contains_secret(&serde_json::json!({"title": "extra context"})));
    }

    #[test]
    fn redaction_matches_plain_and_encoded_values_across_stderr_reads() {
        let secrets = Redactions::default();
        secrets.register(["my/token"]);
        let mut output = secrets.stream();
        let bytes = [
            output.push(b"use my/to"),
            output.push(b"ken, my%2"),
            output.push(b"Ftoken, and bXkvdG9rZW4="),
            output.finish(),
        ]
        .concat();
        assert_eq!(bytes, b"use [redacted], [redacted], and [redacted]");
    }
}
