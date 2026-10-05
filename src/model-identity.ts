import type { ConfigOption } from "./types.ts";

export interface NormalizedModelOptions {
  configOptions: ConfigOption[];
  modelOptionIds: Set<string>;
  modelValueToWireValue: Map<string, Map<string, string>>;
}

function decodeModelPair(value: string): [string, string] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  return Array.isArray(decoded) &&
    decoded.length === 2 &&
    typeof decoded[0] === "string" &&
    typeof decoded[1] === "string"
    ? [decoded[0], decoded[1]]
    : null;
}

/** Derive an id only when the value-only pair decomposition is a fixed point. */
export function canonicalModelIdentity(value: string): string {
  const pair = decodeModelPair(value);
  if (!pair) return value;
  const joined = `${pair[0]}/${pair[1]}`;
  return decodeModelPair(joined) ? value : joined;
}

/** Normalize model options and retain their exact protocol values for writes. */
export function normalizeModelConfigOptions(
  configOptions: ConfigOption[],
): NormalizedModelOptions {
  const modelOptionIds = new Set<string>();
  const modelValueToWireValue = new Map<string, Map<string, string>>();
  const normalized = configOptions.map((option) => {
    if (!("options" in option)) return option;
    if (option.id !== "model" && option.category !== "model") return option;

    modelOptionIds.add(option.id);
    const modelValues = new Map<string, string>();
    const choices = option.options.map((choice) => {
      const canonicalValue = canonicalModelIdentity(choice.value);
      const previous = modelValues.get(canonicalValue);
      if (previous !== undefined && previous !== choice.value) {
        throw new Error(
          `Canonical model identity collision for ${option.id}: ${canonicalValue}`,
        );
      }
      modelValues.set(canonicalValue, choice.value);
      return choice.value === canonicalValue
        ? choice
        : { ...choice, value: canonicalValue };
    });
    modelValueToWireValue.set(option.id, modelValues);

    const currentValue = canonicalModelIdentity(option.currentValue);
    const choicesUnchanged = choices.every(
      (choice, index) => choice === option.options[index],
    );
    if (choicesUnchanged && currentValue === option.currentValue) return option;
    return { ...option, currentValue, options: choices };
  });

  return {
    configOptions: normalized,
    modelOptionIds,
    modelValueToWireValue,
  };
}
