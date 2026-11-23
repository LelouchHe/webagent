import type {
  RemoteTaskCreateTransport,
  TaskCreateHost,
  TaskCreateHostCommand,
  TaskCreateResult,
  TaskOps,
} from "../api/tasks.ts";
import {
  TaskRemoteCreateConfigError,
  TaskRemoteCreatePartialSuccessError,
} from "../api/tasks.ts";

export function createTaskCreateHost(deps: {
  local: TaskOps;
  remote: RemoteTaskCreateTransport;
}): TaskCreateHost {
  return {
    async create(command: TaskCreateHostCommand): Promise<TaskCreateResult> {
      // This is the only location branch for task creation.
      if (command.target.host === undefined) {
        return deps.local.create(command.caller, {
          ...command.input,
          agentId: command.target.agentId,
        });
      }
      if (command.input.model) throw new TaskRemoteCreateConfigError("model");
      if (command.input.thinking) {
        throw new TaskRemoteCreateConfigError("thinking");
      }
      const host = command.target.host;
      const agentId = command.target.agentId;
      if (agentId === undefined || !command.parentId) {
        throw new Error("invalid_remote_create");
      }
      command.assertRemoteCaller();
      const remote = await deps.remote.create(host, {
        agentId,
        parentId: command.parentId,
        ...(command.input.title === undefined
          ? {}
          : { title: command.input.title }),
        ...(command.input.cwd === undefined ? {} : { cwd: command.input.cwd }),
        source:
          command.input.source ??
          (command.caller.kind === "agent" ? "agent" : "auto"),
      });
      try {
        return command.completeRemote(remote, host);
      } catch (error) {
        throw new TaskRemoteCreatePartialSuccessError(host, remote.taskId, {
          cause: error,
        });
      }
    },
  };
}
