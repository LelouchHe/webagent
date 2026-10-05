import type { ConfigOption } from "./types.ts";

type ConfigChoice = Record<string, unknown> & {
  value: string;
  name: string;
};

type ConfigGroup = Record<string, unknown> & {
  name: string;
  options: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isConfigChoice(value: unknown): value is ConfigChoice {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    typeof value.name === "string"
  );
}

function isConfigGroup(value: unknown): value is ConfigGroup {
  return (
    isRecord(value) &&
    typeof value.group === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.options)
  );
}

/** Flatten grouped ACP choices and qualify each leaf's display label. */
export function flattenConfigOptions(
  configOptions: ConfigOption[],
): ConfigOption[] {
  return configOptions.map((option) => {
    if (!("options" in option)) return option;
    const sourceChoices: unknown[] = option.options;
    if (!sourceChoices.some(isConfigGroup)) return option;

    const choices: ConfigChoice[] = [];
    for (const choice of sourceChoices) {
      if (isConfigGroup(choice)) {
        for (const leaf of choice.options) {
          if (isConfigChoice(leaf)) {
            choices.push({ ...leaf, name: `${choice.name}/${leaf.name}` });
          }
        }
      } else if (isConfigChoice(choice)) {
        choices.push(choice);
      }
    }
    return { ...option, options: choices };
  });
}
