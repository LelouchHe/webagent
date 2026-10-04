import type { ConfigOption } from "./types.ts";

export interface NormalizedModelOptions {
  configOptions: ConfigOption[];
  modelOptionIds: Set<string>;
  modelValueToWireValue: Map<string, Map<string, string>>;
}

/** Derive WebAgent's model identity only from an explicitly encoded value pair. */
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
