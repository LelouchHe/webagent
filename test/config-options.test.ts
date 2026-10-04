import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalModelIdentity,
  normalizeConfigOptions,
} from "../src/config-options.ts";
import type { ConfigOption, ConfigSelectOption } from "../src/types.ts";

describe("config option normalization", () => {
  it("flattens group and leaf order while retaining leaf metadata", () => {
    const grouped = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: JSON.stringify(["vendor-a", "model-two"]),
      options: [
        {
          group: "vendor-a",
          name: "Vendor A",
          options: [
            {
              value: JSON.stringify(["vendor-a", "model-one"]),
              name: "Model One",
              description: "First choice",
              _meta: { rank: 1 },
              extensionField: ["retained"],
            },
            {
              value: JSON.stringify(["vendor-a", "model-two"]),
              name: "Model Two",
            },
          ],
        },
        {
          group: "vendor-b",
          name: "Vendor B",
          options: [
            {
              value: JSON.stringify(["vendor-b", "model-three"]),
              name: "Model Three",
            },
          ],
        },
      ],
    } as unknown as ConfigOption;

    const normalized = normalizeConfigOptions([grouped]).configOptions[0];
    assert.ok("options" in normalized);
    assert.equal(normalized.currentValue, "vendor-a/model-two");
    assert.deepEqual(
      normalized.options.map(({ value, name }) => ({ value, name })),
      [
        { value: "vendor-a/model-one", name: "Vendor A/Model One" },
        { value: "vendor-a/model-two", name: "Vendor A/Model Two" },
        { value: "vendor-b/model-three", name: "Vendor B/Model Three" },
      ],
    );
    assert.deepEqual(normalized.options[0], {
      value: "vendor-a/model-one",
      name: "Vendor A/Model One",
      description: "First choice",
      _meta: { rank: 1 },
      extensionField: ["retained"],
    });
  });

  it("keeps a flat canonical option payload and its label unchanged", () => {
    const flat: ConfigSelectOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "vendor-a/model-one",
      options: [{ value: "vendor-a/model-one", name: "vendor-a/Model One" }],
    };
    const normalized = normalizeConfigOptions([flat]).configOptions[0];
    assert.strictEqual(normalized, flat);
  });

  it("does not invent provider identity from a group label", () => {
    const grouped = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "opaque-model-id",
      options: [
        {
          group: "fast",
          name: "Fast",
          options: [{ value: "opaque-model-id", name: "Best model" }],
        },
      ],
    } as unknown as ConfigOption;
    const result = normalizeConfigOptions([grouped]);
    const option = result.configOptions[0];
    assert.ok("options" in option);
    assert.equal(option.currentValue, "opaque-model-id");
    assert.deepEqual(option.options[0], {
      value: "opaque-model-id",
      name: "Fast/Best model",
    });
    assert.equal(
      result.modelValueToWireValue.get("model")?.get("opaque-model-id"),
      "opaque-model-id",
    );
    assert.equal(
      canonicalModelIdentity('["fast","model","extra"]'),
      '["fast","model","extra"]',
    );
  });

  it("rejects distinct wire choices that collide on canonical identity", () => {
    const grouped = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: JSON.stringify(["vendor-a", "model-one"]),
      options: [
        {
          group: "vendor-a",
          name: "Vendor A",
          options: [
            {
              value: JSON.stringify(["vendor-a", "model-one"]),
              name: "Encoded",
            },
            { value: "vendor-a/model-one", name: "Canonical" },
          ],
        },
      ],
    } as unknown as ConfigOption;
    assert.throws(
      () => normalizeConfigOptions([grouped]),
      /Canonical model identity collision for model: vendor-a\/model-one/,
    );
  });
});
