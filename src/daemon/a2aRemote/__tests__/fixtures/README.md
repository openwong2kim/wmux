# Test-only TLS fixtures — not a secret

`cert-a.pem`/`key-a.pem` and `cert-b.pem`/`key-b.pem` are two throwaway,
self-signed EC P-256 certificates (`CN=wmux-a2a-test-a` / `-b`) used only by
`pinnedClient.test.ts` to stand up local TLS servers. They protect nothing and
are trusted by nothing. They are committed so the tests never shell out to
`openssl` (Windows CI runners may not have it).

Regenerate with:

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 \
      -nodes -keyout key-a.pem -out cert-a.pem -days 36500 -subj "/CN=wmux-a2a-test-a"

# Background-work transcripts

`background/hooks.jsonl` and `background/nohooks.jsonl` are two real Claude
Code 2.1 turns (with its hooks on, and with `disableAllHooks`): a command run
in the background, the turn that ends before it does, the task notification,
and the turn that reads its output. They were cut down to the entry types and
fields `headlessDelivery.ts` and `subagentCount.ts` read; ids, paths and the
assistant's words were replaced (it answered in another language).

# A prompt stored as a paste

`pasted/prompt.jsonl` is one turn whose prompt Claude Code stored as a paste,
as it does for a long or multi-line prompt (#3412). The prompt entry's fields
are those of the real 2.1 turn in `background/hooks.jsonl`; its content is the
form recorded from Claude Code 2.1.326 on a headless host in #3412: the prompt
inside `<pasted_content id="…">` markers, with line breaks around them. The
tool call, its result and the answer follow the shape of the same real turn.

