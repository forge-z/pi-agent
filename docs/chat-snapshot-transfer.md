# Compact chat transport

The Mac Safari investigation after PR #15 measured a harmless send ACK in
27–136 ms, followed by a conversation snapshot taking 11–13 seconds: roughly
12.4 MB transferred and 24.3 MB decoded. The full snapshot also traveled over
SSE. A white screen was not reproduced in that session. Those observations
support reducing transport and rendering work; they do not establish CSP,
sourcemaps, or a particular Safari exception as the cause.

PR #15 reached `main` at `2891e9b`. PR #16 merged into
`review/telegram-api-integrated`, so its Markdown preflight and persistent CUA
control-return changes were absent from that main tree. This local branch
applies those two commits separately before the transport change.

## Protocol and preservation

The existing conversation GET and SSE routes accept `?view=chat&page=N`.
Page zero is the newest page; each page contains at most 80 human-visible
messages with stable entry/message keys. Message previews have a shared
4,096-character budget and bounded nesting, fields, array items, and nodes.
Image bytes and hidden reasoning are omitted from those previews. Original
Durable entries, historical content, tool payloads, and model context are not
rewritten. The legacy routes without this opt-in retain their original full
snapshot behavior.

The initial SSE event and reconnect send a compact `snapshot` with the selected
page. When its historical keys do not change, subsequent events use `state`
with `historyVersion` and omit the history. A new durable message sends a new
compact snapshot. Existing stream deduplication and backpressure handling remain
in place. The browser rejects responses from an obsolete conversation/page
selection or an older render, so a late GET cannot overwrite newer SSE state.

The authenticated history-message and action-detail GET routes return the
original complete data on explicit download. The browser creates a download
instead of rendering that large JSON into the document. History-message access
uses the conversation's fork-aware Durable view, including its inherited
entries but excluding entries outside the fork boundary and hidden CUA controls.

Completed action arguments/results and reconciliation summaries are abbreviated
in chat snapshots; their underlying records remain intact. Pending approval
arguments and pending MCP interaction payloads remain complete so their existing
review controls preserve the exact information being approved. Consequently,
this is not an absolute bound for every possible snapshot: one unusually large
pending approval, pending MCP schema, or a very large action collection can
still be expensive. The runtime also still loads its native Durable view on the
server; this change primarily reduces HTTP/SSE serialization, transfer, and
browser work rather than redesigning Durable replication.

## Verification in the cloud workspace

All checks ran against the final implementation with synthetic data and mocked
providers/tools, without real credentials or external service calls:

- Full suite: 449 passed, zero failed. Type checking, lint, and build passed.
- A 1,600-entry history occupying 24,780,878 JSON bytes retained all original
  stored data and all message keys across 20 pages. Its largest projected page
  was 335,609 bytes. Compact SSE frames measured 335,631 bytes initially,
  5,030 bytes for an oversized live source, and 9,346 bytes after an oversized
  completed action. Original multi-megabyte messages/actions remained available
  through the authenticated lazy routes.
- Chromium stress at 1280×900, 390×844, and 812×375 walked all historical pages,
  performed an original-content download, sent a harmless message, and consumed
  live SSE updates. No browser errors occurred; compact GETs peaked at 335,800
  bytes, incremental states at 940 bytes, and send ACKs at 173–202 ms under
  concurrent local test load. DOM node counts stayed near 1,300. These are local
  Chromium measurements, not native Safari performance claims.
- Independent Sol 6.1 review revalidated stale GET/SSE races, fork access,
  completed large arguments, and focused tests. It found no remaining confirmed
  blocker and explicitly recorded the large pending-approval exception.

The reproducible loopback-only browser fixture is
`test/fixtures/snapshot-transfer-preview.ts`. Native Safari verification with the
served build remains necessary. No deployment, remote publication, or merge
was performed for this branch.
