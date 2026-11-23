use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use aho_corasick::{AhoCorasick, MatchKind};
use base64::{Engine as _, engine::general_purpose};
use serde_json::Value;

const MARKER: &[u8] = b"[redacted]";

#[derive(Clone, Default)]
pub(super) struct Redactions(Arc<Mutex<Patterns>>);

#[derive(Default)]
struct Patterns {
    values: BTreeSet<Vec<u8>>,
    matcher: Option<AhoCorasick>,
    longest: usize,
}

impl Redactions {
    pub(super) fn register<'a>(&self, secrets: impl IntoIterator<Item = &'a str>) {
        let mut patterns = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let before = patterns.values.len();
        for secret in secrets {
            if secret.is_empty() || patterns.values.contains(secret.as_bytes()) {
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
            let lower_percent = regex::Regex::new("%[0-9A-F]{2}");
            if let Ok(lower_percent) = lower_percent {
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
            patterns.matcher = AhoCorasick::builder()
                .match_kind(MatchKind::LeftmostLongest)
                .build(&patterns.values)
                .ok();
        }
    }

    pub(super) fn bytes(&self, input: &[u8]) -> Vec<u8> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(input, input.len())
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
        }
    }
}

impl Patterns {
    fn contains_value(&self, value: &Value) -> bool {
        match value {
            Value::String(value) => self.contains(value),
            Value::Array(values) => values.iter().any(|value| self.contains_value(value)),
            Value::Object(values) => values
                .iter()
                .any(|(key, value)| self.contains(key) || self.contains_value(value)),
            _ => false,
        }
    }

    fn contains(&self, input: &str) -> bool {
        let Some(matcher) = &self.matcher else {
            return !self.values.is_empty();
        };
        let bytes = input.as_bytes();
        matcher.find_iter(bytes).any(|matched| {
            let word = |byte: Option<&u8>| byte.is_some_and(u8::is_ascii_alphanumeric);
            // Avoid treating a one-character credential as a match inside an
            // unrelated word, while still rejecting it as an echoed value.
            matched.len() >= 6
                || (!word(
                    matched
                        .start()
                        .checked_sub(1)
                        .and_then(|index| bytes.get(index)),
                ) && !word(bytes.get(matched.end())))
        })
    }

    fn replace(&self, input: &[u8], release: usize) -> (Vec<u8>, usize) {
        let Some(matcher) = &self.matcher else {
            return if self.values.is_empty() || input.is_empty() {
                (input[..release].to_vec(), release)
            } else {
                (MARKER.to_vec(), input.len())
            };
        };
        let mut output = Vec::new();
        let mut start = 0;
        for matched in matcher
            .find_iter(input)
            .take_while(|matched| matched.start() < release)
        {
            output.extend_from_slice(&input[start..matched.start()]);
            output.extend_from_slice(MARKER);
            start = matched.end();
        }
        let consumed = start.max(release);
        output.extend_from_slice(&input[start..consumed]);
        (output, consumed)
    }
}

/// Holds back enough bytes to replace a secret split across pipe reads.
pub(super) struct RedactedStream {
    redactions: Redactions,
    pending: Vec<u8>,
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
        let (result, consumed) = patterns.replace(&self.pending, release);
        self.pending.drain(..consumed);
        result
    }

    pub(super) fn finish(&mut self) -> Vec<u8> {
        self.redactions.bytes(&std::mem::take(&mut self.pending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
