import type { ConfigOption, ConfigSelectOption } from "./types.ts";

export interface NormalizedConfigOptions {
  configOptions: ConfigOption[];
  modelOptionIds: Set<string>;
  modelValueToWireValue: Map<string, Map<string, string>>;
}

type ConfigChoice = Record<string, unknown> & {
  value: string;
  name: string;
};

type ConfigGroup = Record<string, unknown> & {
  group: string;
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

/** Derive a provider/model identity only from an explicitly encoded pair. */
export function canonicalModelIdentity(value: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return value;
  }
  if (
    Array.isArray(decoded) &&
    decoded.length === 2 &&
    typeof decoded[0] === "string" &&
    typeof decoded[1] === "string"
  ) {
    return `${decoded[0]}/${decoded[1]}`;
  }
  return value;
}

function flattenChoices(sourceChoices: unknown[]): {
  grouped: boolean;
  leaves: Array<{ choice: ConfigChoice; groupName?: string }>;
} {
  const grouped = sourceChoices.some(isConfigGroup);
  const leaves: Array<{ choice: ConfigChoice; groupName?: string }> = [];
  for (const choice of sourceChoices) {
    if (isConfigGroup(choice)) {
      for (const leaf of choice.options) {
        if (isConfigChoice(leaf)) {
          leaves.push({ choice: leaf, groupName: choice.name });
        }
      }
    } else if (isConfigChoice(choice)) {
      leaves.push({ choice });
    }
  }
  return { grouped, leaves };
}

function normalizeSelectOption(
  option: ConfigSelectOption,
  modelOptionIds: Set<string>,
  modelValueToWireValue: Map<string, Map<string, string>>,
): ConfigSelectOption {
  const modelOption = option.id === "model" || option.category === "model";
  if (modelOption) modelOptionIds.add(option.id);

  const sourceChoices: unknown[] = option.options;
  const { grouped, leaves } = flattenChoices(sourceChoices);
  const modelValues = modelOption ? new Map<string, string>() : null;
  const options = leaves.map(({ choice, groupName }) => {
    const canonicalValue = modelOption
      ? canonicalModelIdentity(choice.value)
      : choice.value;
    if (modelValues) {
      const previous = modelValues.get(canonicalValue);
      if (previous !== undefined && previous !== choice.value) {
        throw new Error(
          `Canonical model identity collision for ${option.id}: ${canonicalValue}`,
        );
      }
      modelValues.set(canonicalValue, choice.value);
    }
    const name =
      groupName === undefined ? choice.name : `${groupName}/${choice.name}`;
    if (choice.value === canonicalValue && name === choice.name) return choice;
    return { ...choice, value: canonicalValue, name };
  });

  if (modelValues) modelValueToWireValue.set(option.id, modelValues);
  const currentValue = modelOption
    ? canonicalModelIdentity(option.currentValue)
    : option.currentValue;
  const choicesUnchanged =
    !grouped &&
    options.every((choice, index) => choice === sourceChoices[index]);
  if (choicesUnchanged && currentValue === option.currentValue) return option;
  return { ...option, currentValue, options };
}

/** Flatten ACP grouped choices and build the model identity-to-wire codec. */
export function normalizeConfigOptions(
  configOptions: ConfigOption[],
): NormalizedConfigOptions {
  const modelOptionIds = new Set<string>();
  const modelValueToWireValue = new Map<string, Map<string, string>>();
  const normalized = configOptions.map((option) => {
    if (!("options" in option)) return option;
    return normalizeSelectOption(option, modelOptionIds, modelValueToWireValue);
  });

  return {
    configOptions: normalized,
    modelOptionIds,
    modelValueToWireValue,
  };
}
