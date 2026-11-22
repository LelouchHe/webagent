import { randomUUID } from "node:crypto";
import { requestHash } from "./protocol.ts";
import type { HostRegistry } from "./registry.ts";
import type { HostStore } from "./store.ts";

export class HostTaskCreator {
  private readonly hostStore: HostStore;
  private readonly registry: HostRegistry;

  constructor(hostStore: HostStore, registry: HostRegistry) {
    this.hostStore = hostStore;
    this.registry = registry;
  }

  async create(input: {
    sourceTaskId: string;
    title: string;
    agent: string;
    cwd?: string;
    model?: string;
    thinking?: string;
    assertCaller: () => void;
  }): Promise<{ handled: boolean; taskId?: string }> {
    const target = this.registry.remoteAgentId(input.agent);
    if (!target) return { handled: false };
    if (this.hostStore.siblingTitleExists(input.sourceTaskId, input.title)) {
      throw new Error("task_title_conflict");
    }
    const createKey = randomUUID();
    const request = {
      createKey,
      parentTaskId: input.sourceTaskId,
      agent: target.agentId,
      title: input.title,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
    };
    const result = await this.registry.createTask({
      hostName: target.hostName,
      credentialHash: target.credentialHash,
      request,
    });
    input.assertCaller();
    const created = this.hostStore.createHostEdge({
      parentTaskId: input.sourceTaskId,
      hostName: target.hostName,
      remoteTaskId: result.taskId,
      title: input.title,
      credentialHash: result.credentialHash,
      createKey,
      requestHash: requestHash(request),
      event: {
        title: `Created remote task ${input.title} @${target.hostName}`,
        body: `Host: ${target.hostName}\nTask: ${result.taskId}`,
        kind: "task_created_remote",
        taskId: result.taskId,
        taskTitle: input.title,
        agentId: target.agentId,
        cwd: input.cwd ?? "owner default or explicit path",
        model: input.model ?? null,
        thinking: input.thinking ?? null,
      },
    });
    if (created.status === "conflict" || !created.edge) {
      throw new Error("task_create_conflict");
    }
    return { handled: true, taskId: result.taskId };
  }
}
