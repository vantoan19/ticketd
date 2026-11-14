//! Small readers shared by the harness adapters for the JSON they receive and the
//! words they report from it.
use serde_json::Value;

/// The string at `key`, when there is one.
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `word` with its first letter upper-cased, as a harness's own id reads as a label.
pub(crate) fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitalizes_the_first_letter_only() {
        assert_eq!(capitalized("high"), "High");
        assert_eq!(capitalized("xHigh"), "XHigh");
        assert_eq!(capitalized(""), "");
    }
}
