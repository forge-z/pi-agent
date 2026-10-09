# Private CUA human handoff

This integration uses the configured CUA MCP connection and its existing bearer token, including operator-provisioned `tokenFile`. The optional `cuaViewer: true` setting requires `mode: "direct"` and a credential-free HTTPS URL with the exact `/mcp` path. Existing connections remain disabled unless explicitly opted in. No new environment variables, deployment services or data volumes are required.

The local `cua_request_handoff({server})` tool offers only opted-in server names. It requires an active web/Telegram human input; scheduled and system inputs cannot create handoffs. The tool returns a request ID, server, state and pause explanation. It never returns a ticket, URL, root credential or viewer principal to the model. Normal MCP tool names remain visible. MCP URL elicitation and legacy action approval retain their separate semantics.

## Human API and state

Authenticated conversation snapshots include `cuaHandoffs`: `{id, conversationId, server, state, createdAt, expiresAt, url}`. The URL appears only for an active, unexpired ticket in the human interface. All mutations require the existing web session and exact application Origin. IDs are checked against the owning conversation.

- `POST /api/conversations/:conversationId/cua-handoffs/:id/create`, body `{}`: explicitly creates one private ticket for a pending request. Repeated clicks cannot issue a second ticket. Only local preflight failures proven not to have dispatched can return the request to pending.
- `POST .../:id/end`, body `{cancel: true}`: cancels a pending request before viewer access was created.
- `POST .../:id/end`, body `{allTabsClosed: true, controlReturned: true}`: ends an active handoff only with both explicit human acknowledgments and an unchanged connection credential binding. It deletes the URL from the current database row. Ending itself does not submit a model message, repeat an MCP call or admit previously unsent work.

Normal states are `pending → creating → active → ended`. Every state except ended holds the automation lease, including `uncertain`. A ticket creation dispatched before a timeout, malformed response, binding change or post-mint storage failure becomes uncertain. Uncertain or creating requests cannot be cancelled, released or issued another ticket through this API. On restart, creating becomes uncertain; pending, active and uncertain keep their holds. No timer, ticket expiry or restart releases control automatically.

The viewer protocol client creates a 30-minute `CreateViewerTicket` using policy 3, clipboard disabled, empty files root, audio disabled and a unique `viewer:pi-handoff-UUID` principal. It verifies the returned ticket signature, grants, principal, expiry and same-origin HTTPS `/viewer/` URL before the URL reaches the human snapshot. Its fixed scope and mock wire validation are covered in `test/cua-viewer.test.ts`.

## Dispatch and recovery

A persistent unique lease covers the complete CUA origin, including other configured names and legacy connections using that origin. Both direct and legacy tool sends check the lease inside the server queue before connection work and again immediately before dispatch. Handoff creation also refuses active calls and pending, paused or uncertain MCP/action effects at that origin. A queued call that has not dispatched is classified as not sent.

Every owner-conversation tool is blocked while held, including tools targeting other servers or the local agenda. A native `beforeTool` hook handles new tool intents; executor guards also handle Pi Durable's recovery of replay-safe execute checkpoints. Human prompt/command admission reports a temporary conversation busy error. Calendar ticks retain the original once/cron occurrence instead of claiming it; already-pending manual runs remain pending for retry after control is explicitly returned.

Ticket minting rejects a busy owner conversation instead of aborting its job. Startup reacquires existing submission handles and reattaches settlement monitors without admitting new inputs. A rare pre-crash request persisted before Durable admission stays pending while held. End/cancel does not execute it: after release, an explicit retry with that request ID, the normal calendar retry for a scheduled input, or subsequent normal restart recovery can admit it. The interface does not currently provide a separate deferred-input recovery button.

Viewer URLs exist only in the private application database while active and in authenticated human snapshots. Tool results, model transcripts, action ledgers, Telegram outcomes and server error text do not carry the ticket. End removes the current URL value; this is logical deletion, not forensic erasure of SQLite WAL files or prior backups.

## Service limits and review boundary

The current CUA service does not provide per-viewer revocation or an authoritative inventory of attached viewer sessions. An already-attached WebSocket may remain active after ticket expiry. Returning control is therefore a **human attestation**, not service verification: the user must close every viewer tab and explicitly return control. Ending a handoff does not remotely revoke the ticket, and a retained ticket could be reopened until its expiry. The UI explains this limitation. The backend masks expired URLs while retaining the active hold.

An uncertain creation remains blocked because the application cannot prove that no usable viewer access exists. Operator investigation is required; there is deliberately no automatic retry or generic force-release endpoint. This implementation does not claim isolation from viewers created outside the application, root-token revocation, remotely proven tab closure or automatic destruction of viewer media.

Independent review considers remote exclusivity unproven. If fail-closed protection requires proof that every viewer session ended, this implementation must not be activated as-is. Human-attestation return needs an explicit reviewed acceptance of this residual risk before real-service use or publication. The original request for private 30-minute access and restricted capabilities does not itself establish that acceptance.

Validation uses temporary SQLite stores, the installed Pi/MCP runtimes, faux model responses, a stubbed viewer client and loopback HTTP. No real CUA account, viewer, credential, external network service or paid model was used. Real-service validation and publication remain separate review decisions.
