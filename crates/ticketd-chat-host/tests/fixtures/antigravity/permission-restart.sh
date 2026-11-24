#!/bin/sh

if [ "$1" = "--version" ]; then
    printf 'agy 1.5.15\n'
    exit 0
fi
[ "$1" = "acp" ] || exit 1
printf 'launch %s\n' "$*" >> agy.calls

id=0
permission=default
model=initial
effort=low
configs() {
    case "$model" in
        quick) options='[{"value":"minimal","name":"Minimal"}]' ;;
        *) options='[{"value":"low","name":"Low"},{"value":"high","name":"High"}]' ;;
    esac
    printf '[{"id":"permission","name":"Permission","category":"mode","type":"select","currentValue":"%s","options":[{"value":"default","name":"Ask"},{"value":"accept-edits","name":"Accept edits"}]},{"id":"model","name":"Model","category":"model","type":"select","currentValue":"%s","options":[{"value":"initial","name":"Initial"},{"value":"quick","name":"Quick"},{"value":"balanced","name":"Balanced"}]},{"id":"effort","name":"Thinking","category":"thought_level","type":"select","currentValue":"%s","options":%s}]' "$permission" "$model" "$effort" "$options"
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
        *'"method":"session/set_config_option"'*'"configId":"model"'*'"value":"quick"'*)
            printf 'configure quick\n' >> agy.calls
            model=quick
            effort=minimal
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/set_config_option"'*'"configId":"model"'*'"value":"balanced"'*)
            printf 'configure balanced\n' >> agy.calls
            model=balanced
            effort=low
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/set_config_option"'*'"configId":"effort"'*'"value":"high"'*)
            printf 'configure high\n' >> agy.calls
            effort=high
            if [ "${PWD##*/}" = refused ]; then
                # This reply accepts the effort but resets the earlier permission.
                permission=default
            fi
            result='{"configOptions":'"$(configs)"'}' ;;
        *'"method":"session/prompt"'*)
            case "${PWD##*/}" in
                held-*)
                    printf 'prompt %s %s\n' "$model" "$effort" >> agy.calls
                    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Working"}}}}'
                    remaining=1000
                    while [ ! -f agy.release ] && [ "$remaining" -gt 0 ]; do
                        /bin/sleep 0.01
                        remaining=$((remaining - 1))
                    done
                    [ -f agy.release ] || exit 1 ;;
                *) printf 'prompt\n' >> agy.calls ;;
            esac
            result='{"stopReason":"end_turn"}' ;;
        *) exit 1 ;;
    esac
    printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
