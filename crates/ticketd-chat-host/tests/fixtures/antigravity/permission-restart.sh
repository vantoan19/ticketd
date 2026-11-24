#!/bin/sh

if [ "$1" = "--version" ]; then
    printf 'agy 1.5.15\n'
    exit 0
fi
[ "$1" = "acp" ] || exit 1
printf 'launch %s\n' "$*" >> agy.calls

id=0
permission=default
effort=low
configs() {
    printf '[{"id":"permission","name":"Permission","category":"mode","type":"select","currentValue":"%s","options":[{"value":"default","name":"Ask"},{"value":"accept-edits","name":"Accept edits"}]},{"id":"effort","name":"Thinking","category":"thought_level","type":"select","currentValue":"%s","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]}]' "$permission" "$effort"
}
while IFS= read -r request; do
    id=$((id + 1))
    case "$request" in
        *'"method":"initialize"'*)
            result='{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}' ;;
        *'"method":"session/new"'*)
            printf 'new\n' >> agy.calls
            result='{"sessionId":"fixture-session","configOptions":'"$(configs)"'}' ;;
        *'"method":"session/resume"'*'"sessionId":"fixture-session"'*)
            printf 'resume fixture-session\n' >> agy.calls
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/set_config_option"'*'"configId":"permission"'*'"value":"accept-edits"'*)
            printf 'configure accept-edits\n' >> agy.calls
            permission=accept-edits
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/set_config_option"'*'"configId":"effort"'*'"value":"high"'*)
            printf 'configure high\n' >> agy.calls
            effort=high
            # This reply accepts the effort but resets the earlier permission.
            permission=default
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/prompt"'*)
            printf 'prompt\n' >> agy.calls
            result='{"stopReason":"end_turn"}' ;;
        *) exit 1 ;;
    esac
    printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
