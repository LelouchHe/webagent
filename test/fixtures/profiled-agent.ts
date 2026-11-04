import type { ConfigOption } from "../../src/types.ts";

/**
 * A transport that reports one configured agent's execution environment.
 *
 * Unlike the repo's generic bridge doubles, this one carries *agent identity*
 * (`agentId`) and a schema whose `currentValue` is deliberately distinguishable
 * from every other agent's: a test can tell "this agent's own default" from
 * "the previous agent's value" and from "the first entry of the option list".
 *
 * Every call is recorded, so counting sessions per agent is a plain array read.
 */

export interface ConfigWrite {
  taskId: string;
  id: string;
  value: string;
}

export interface ProfiledAgent {
  agentId: string;
  /** Sessions this agent created, in order. */
  newSessions: string[];
  /** Config writes this agent received, in order. */
  configWrites: ConfigWrite[];
  /** Tasks this agent was asked to restore. */
  loads: string[];
  /** Executions this agent retired. */
  retired: string[];
  bridge: {
    agentId: string;
    newSession(cwd: string): Promise<{
      sessionId: string;
      configOptions: ConfigOption[];
    }>;
    setConfigOption(
      taskId: string,
      configId: string,
      value: string,
    ): Promise<ConfigOption[]>;
    loadSession(
      taskId: string,
      cwd: string,
    ): Promise<{ taskId: string; configOptions: ConfigOption[] }>;
    retireExecution(agentSessionId: string): Promise<void>;
    isAvailable(): boolean;
  };
}

/** Deep copy so one session's mutation cannot leak into another's report. */
function copyOptions(configOptions: ConfigOption[]): ConfigOption[] {
  return JSON.parse(JSON.stringify(configOptions)) as ConfigOption[];
}

export function createProfiledAgent(
  agentId: string,
  schema: ConfigOption[],
): ProfiledAgent {
  const newSessions: string[] = [];
  const configWrites: ConfigWrite[] = [];
  const loads: string[] = [];
  const retired: string[] = [];

  const bridge = {
    agentId,
    async newSession(cwd: string) {
      newSessions.push(cwd);
      return {
        sessionId: `${agentId}-session-${newSessions.length}`,
        // A fresh session reports this agent's own defaults.
        configOptions: copyOptions(schema),
      };
    },
    async setConfigOption(taskId: string, configId: string, value: string) {
      configWrites.push({ taskId, id: configId, value });
      return copyOptions(schema).map((option) =>
        option.id === configId && "options" in option
          ? { ...option, currentValue: value }
          : option,
      );
    },
    async loadSession(taskId: string, _cwd: string) {
      loads.push(taskId);
      return { taskId, configOptions: copyOptions(schema) };
    },
    async retireExecution(agentSessionId: string) {
      retired.push(agentSessionId);
    },
    isAvailable() {
      return true;
    },
  };

  return { agentId, newSessions, configWrites, loads, retired, bridge };
}

/** The three execution-config options, in ACP shape. */
export function executionSchema(profile: {
  model: { current: string; options: string[] };
  mode: { current: string; options: string[] };
  reasoning: { current: string; options: string[] };
}): ConfigOption[] {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: profile.model.current,
      options: profile.model.options.map((value) => ({ value, name: value })),
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: profile.mode.current,
      options: profile.mode.options.map((value) => ({ value, name: value })),
    },
    {
      type: "select",
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      currentValue: profile.reasoning.current,
      options: profile.reasoning.options.map((value) => ({
        value,
        name: value,
      })),
    },
  ];
}
