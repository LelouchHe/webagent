import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenConfigOptions } from "../src/config-options.ts";
import {
  canonicalModelIdentity,
  normalizeModelConfigOptions,
} from "../src/model-identity.ts";
import type { ConfigOption, ConfigSelectOption } from "../src/types.ts";

function groupedModelOption(group: string, name: string, value: string) {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: value,
    options: [
      {
        group,
        name,
        options: [{ value, name: "Selected Model" }],
      },
    ],
  } as unknown as ConfigOption;
}

describe("model identity codec", () => {
  it("derives identity from the wire value, not a group that may change", () => {
    const wireValue = JSON.stringify(["vendor-a", "model-one"]);
    const firstSession = normalizeModelConfigOptions(
      flattenConfigOptions([
        groupedModelOption("quality-tier", "Quality Tier", wireValue),
      ]),
    );
    const regroupedSession = normalizeModelConfigOptions(
      flattenConfigOptions([
        groupedModelOption("cost-tier", "Cost Tier", wireValue),
      ]),
    );

    const firstOption = firstSession.configOptions[0];
    const regroupedOption = regroupedSession.configOptions[0];
    assert.ok("options" in firstOption);
    assert.ok("options" in regroupedOption);
    assert.equal(firstOption.currentValue, "vendor-a/model-one");
    assert.equal(regroupedOption.currentValue, "vendor-a/model-one");
    assert.equal(firstOption.options[0]?.value, "vendor-a/model-one");
    assert.equal(regroupedOption.options[0]?.value, "vendor-a/model-one");
    assert.equal(firstOption.options[0]?.name, "Quality Tier/Selected Model");
    assert.equal(regroupedOption.options[0]?.name, "Cost Tier/Selected Model");
    assert.equal(
      regroupedSession.modelValueToWireValue
        .get("model")
        ?.get("vendor-a/model-one"),
      wireValue,
    );
  });

  it("leaves opaque values unchanged and never infers identity from their group", () => {
    const value = "opaque-model-id";
    const flattened = flattenConfigOptions([
      groupedModelOption("fast", "Fast", value),
    ]);
    const normalized = normalizeModelConfigOptions(flattened);
    const option = normalized.configOptions[0];
    assert.ok("options" in option);
    assert.equal(option.currentValue, value);
    assert.deepEqual(option.options[0], {
      value,
      name: "Fast/Selected Model",
    });
    assert.equal(
      normalized.modelValueToWireValue.get("model")?.get(value),
      value,
    );
  });

  it("preserves already-canonical flat options unchanged", () => {
    const flat: ConfigSelectOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "vendor-a/model-one",
      options: [{ value: "vendor-a/model-one", name: "vendor-a/Model One" }],
    };
    assert.strictEqual(
      normalizeModelConfigOptions([flat]).configOptions[0],
      flat,
    );
  });

  it("leaves values outside the decomposable pair shape opaque", () => {
    assert.equal(
      canonicalModelIdentity('["vendor-a","model-one","extra"]'),
      '["vendor-a","model-one","extra"]',
    );
    assert.equal(
      canonicalModelIdentity("vendor-a/model-one"),
      "vendor-a/model-one",
    );
  });

  it("rejects distinct wire choices that collide on canonical identity", () => {
    const option = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: JSON.stringify(["vendor-a", "model-one"]),
      options: [
        {
          value: JSON.stringify(["vendor-a", "model-one"]),
          name: "Encoded",
        },
        { value: "vendor-a/model-one", name: "Canonical" },
      ],
    } as unknown as ConfigOption;
    assert.throws(
      () => normalizeModelConfigOptions([option]),
      /Canonical model identity collision for model: vendor-a\/model-one/,
    );
  });
});
