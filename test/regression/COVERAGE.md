# Regression coverage

The regression suite observes external behavior only. The plan's internally
observable ordering, fences, transaction windows, and timer interleavings stay
in focused tests; introducing a control hook for them would violate A0's
scope.

## Golden scenarios

| Scenario | Plan areas observed externally |
|---|---|
| `mcp-authorization` | missing REST/MCP bearer 401; `task_list` during initialization; stale capability after execution rotation; unknown/out-of-family query, read, send and cancel; no side effect in the caller response/SSE/DB snapshot |
| `mcp-list` | own family list and execution projection; query range; complete read; cold/public REST history response |
| `mcp-authorization-tree` | a real root/child/sibling tree; child-to-parent send without an obligation, parent history read; self, sibling, and parent cancel rejection; missing `task_not_found` vs relation `target_not_allowed`; rejected calls leave only the caller turn's ordinary rows |
| `mcp-lifecycle` | create direct child; durable send and handover; declared child wait; MCP cancellation really reaches `session/cancel`; query the child's cancelled history |
| `mcp-collaboration` | create -> queued/delivered collaboration -> declared child wait -> cancellation -> child `task_update(done)` -> parent notice and readable prompt; account closure visible in the final snapshot |
| `mcp-update-status` | `blocked` settlement; no-account `done` fallback to a real parent; `waiting` where the only visible wake source is a dispatch queued behind a busy child |
| `mcp-cold-family` | an active child lists and reads its unmaterialized parent without an ACP session, server-driven warm, or flush for the parent |
| `mcp-create-errors` | invalid cwd and duplicate sibling title return MCP errors and leave no failed task rows/session |
| `mcp-delete-notice` | cancel an actually waiting delivered target, delete it, and observe the real `target_removed` notice |
| `rest-tasks` | bootstrap, create, prompt, cancel, list, archive, archived list, unarchive; corresponding global SSE and SQL |
| `sse-events` | rename broadcast, user/prompt state transitions, chunks and `prompt_done` on the global stream |

## Existing unit tests guard internal details

| Detail deliberately not orchestrated in golden tests | Existing guard |
|---|---|
| Capability revocation, live-task gate, initialization promotion, frozen principal | `test/mcp.test.ts`: `revoking an unknown task is a no-op`, `rejects POST with an unknown or revoked capability with 401`; `test/multi-agent-mcp.test.ts`: `refuses a business tool until the capability is promoted, then allows it`, `keeps the caller principal frozen` |
| Generation fence after tree-lock/cancel/create waits | `test/multi-agent-mcp.test.ts`: `re-checks the caller after waiting for the tree lock`, `re-checks the caller after the cancel request returns`, `re-checks the caller before writing the source after a child create` |
| Query/read bounds, reverse ranges, duplicate seqs, byte limits, structured data | `test/mcp-task-host.test.ts`: `normalizes negative ranges, reverse ranges, and clamps endpoints`; `reads original structured data in one batch, including thinking`; `rejects an over-limit response with exact required_bytes and no partial rows` |
| Claim, reserve, prompt submission and rejection ordering | `test/collaboration-delivery.test.ts`: `broadcasts delivered at handover, before the turn ends, and failed after a rejection`; `leaves deliveries queued while the target already has an active prompt`; `runs the rejection path, not the turn-end check, after a request-level error` |
| Same-time delivery order and no-work drain | `test/collaboration-delivery.test.ts`: `does not churn the busy turn when nothing is queued`; `drains same-time deliveries in enqueue order` |
| Account coalescing, reminders, `no_update`, silence and waiting wake sources | `test/obligation-controller.test.ts`: `opens one account per edge and coalesces a follow-up dispatch`; `reminds once, then reports no_update and stops`; `reports one notice when a waiting is reported inside a silent turn` |
| Rollback removes state/event/delivery/account effects | `test/collaboration-delivery.test.ts`: `does not mark a turn when the update transaction fails`; `test/archive.test.ts`: `rolls back detach, transcript, and delivery marks as one transaction` |
| Target/source deletion and tombstone notices | `test/collaboration-delivery.test.ts`: `reports target_removed when a dispatch prompt fails`; `reports target_removed when a drain cannot resume the target`; `test/obligation-controller.test.ts`: `reports target_removed when the target disappears` |
| Clear/restart failures and stale resume | `test/collaboration-delivery.test.ts`: `fails queued deliveries but keeps handed-over ones when clear replaces the execution`; `leaves queued work for the current execution after a stale resume` |
| Archive boundary cuts, subtree and Root behavior | `test/archive.test.ts`: `cuts queued work across the subtree boundary, both directions`; `can archive a deeper task out of an already archived tree`; `refuses to archive Root` |
| Task delete / Root exit rebuild and interleaving | `test/tree-deletion.test.ts`: `deletes the whole subtree and retires each execution in its own adapter`; `holds the rebuild against a clear and a second exit` |
| Per-task SSE filtering and replay | `test/sse.test.ts`: `only receives events for its task`; `replays events with seq as SSE id` |
| REST create inheritance/validation and cleanup | `test/multi-agent-mcp-create.test.ts`: `reports the failing session's candidates and leaves nothing behind`; `cleans the task when the model applies and the thinking value fails`; `keeps the same-agent inheritance and override behaviour` |
| Delivery 12: restart with an in-memory account forgotten, followed by explicit re-handover of queued work | Kept in the focused delivery/account unit layer; covered by `test/collaboration-delivery.test.ts`'s `opens the account at handover, so a dispatch queued behind a settled turn gets its own` and the controller's handover/account lifecycle tests. Not reproduced in regression scenarios. |

The plan also lists external cases around two configured agents, permissions,
attachments, Root exit, and browser presentation. They are outside PR A's
task-command port boundary and remain under their named unit/E2E suites; A0
does not reimplement those fixtures.

