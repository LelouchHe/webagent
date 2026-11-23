# A0 entrypoint inventory

Audited independently against `fa627cc`, whose tree is `886c179`'s main
baseline. A caller is covered only by public REST, global SSE, ACP, or
MCP-over-HTTP behavior. A local disposition means PR A does not expose a
routing seam for that caller.

## MCP task commands

| Caller | Task-command seam | A0 disposition |
|---|---|---|
| `src/mcp/tools.ts` `task_list` | `TaskOps.list` in `src/host/task-ops.ts` -> `src/host/local/adapter.ts` family scan and live projection | `mcp-list`, `mcp-cold-family`; `mcp-authorization` for initializing capability |
| `GET /api/v1/version`, `GET /api/v1/auth/verify` | Remote host handshake protocol and caller hash/scope validation | `multi-host-connect`, `multi-host-insufficient-scope`, `multi-host-unauthorized` |
| `task_query` | `TaskOps.query` -> bounded history index | `mcp-list`, `mcp-lifecycle`, `mcp-authorization-tree`, `mcp-cold-family`; shape/range limits remain in `test/mcp-task-host.test.ts` |
| `task_read` | `TaskOps.read` -> selected persisted rows | `mcp-list`, `mcp-authorization-tree`, `mcp-cold-family`; byte limits and structured rows remain in `test/mcp-task-host.test.ts` |
| `task_create` | `TaskOps.create` -> manager creation, source event and broadcast | `mcp-lifecycle`, `mcp-collaboration`, `mcp-create-errors` |
| `task_cancel` | `TaskOps.cancel` -> execution cancellation and audits | `mcp-lifecycle` |
| `task_send` | `TaskOps.send` -> Store message/delivery creation and kick | `mcp-lifecycle`, `mcp-collaboration`, `mcp-authorization-tree` |
| `task_update` | `TaskOps.update` -> settle typed update and side effects | `mcp-collaboration`, `mcp-update-status` |
| Tool registration and capability discovery in `src/mcp/server.ts` / `src/mcp/tools.ts` | frozen principal and initialization window; not a task command | `mcp-authorization`; detailed rotation/revocation guards in `test/mcp.test.ts` and `test/multi-agent-mcp.test.ts` |
| `hasOpenAsSource` -> queued wake-source checks in `TaskManager.settleAgentUpdate` | internal synchronous seam, one caller, no public command | not a A0 assertion; SQL short-circuit and await-order tests remain in the existing task/obligation suites |

## REST task callers

| Public entry | Production seam | A0 disposition |
|---|---|---|
| `POST /api/v1/tasks/bootstrap` | `ensureRootLive` / root activation | setup and `mcp-authorization` |
| `GET /api/v1/tasks` | Store task list projection | `rest-tasks`, `mcp-authorization` |
| `POST /api/v1/tasks` | `TaskManager.createTask` | `rest-tasks` |
| `GET /api/v1/tasks/:id`, status, snapshot, events | read-only Store/state surfaces | transcript reads in `mcp-list`; status/snapshot shapes remain covered by `test/routes.test.ts` and state tests |
| `POST /api/v1/tasks/:id/prompt` | `TaskManager` / real ACP turn | every scenario that uses a prompt |
| `POST /api/v1/tasks/:id/cancel` | `TaskManager.cancelTaskExecution` | `rest-tasks`; MCP adds its own audit in `mcp-lifecycle` |
| `PUT /api/v1/tasks/:id/title` | Store rename and SSE | `sse-events` |
| `POST /api/v1/tasks/:id/archive` / `unarchive` | local tree mutation and delivery/account cut | `rest-tasks`; rollback and edge ordering remain in `test/archive.test.ts` and `test/archive-routes.test.ts` |
| `POST /api/v1/tasks/:source/messages` | arbitrary local collaboration | remains local: owner-side Store/drain behavior has no A TaskOps command |
| `DELETE /api/v1/tasks/:id` and Root exit | local subtree/identity mutation | `mcp-delete-notice` observes the delivered-target removal notice; Root exit and concurrency remain in `test/tree-deletion.test.ts` |
| config/model/mode, clear/compact, bash, permissions, attachments | owner-local execution or filesystem facts | remains local; existing route, bridge, attachment, and E2E suites cover these surfaces |

## SSE

`GET /api/v1/events/stream` is subscribed for every step, including creation,
prompt, collaboration delivery, cancel, title, archive, and state patches.
The task-scoped stream is an owner-local filter over the same broadcasts; its
filtering and replay behavior stays in `test/sse.test.ts` cases
`only receives events for its task`, `replays events from Last-Event-ID`, and
`replays events with seq as SSE id`.

## Stop/go result

The six A TaskOps command groups (`listFamily`, history, `createChild`,
`cancel`, `send`, `update`) all have a caller above and at least one public
scenario. The remaining task routes are explicitly local and do not acquire a
port in A1. No gap requires a production hook or a broader regression fixture.

