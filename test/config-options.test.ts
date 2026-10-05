import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenConfigOptions } from "../src/config-options.ts";
import type { ConfigOption, ConfigSelectOption } from "../src/types.ts";

describe("generic config option flattening", () => {
  it("flattens group and leaf order, qualifies labels, and retains leaf data", () => {
    const firstWireValue = JSON.stringify(["vendor-a", "model-one"]);
    const secondWireValue = JSON.stringify(["vendor-a", "model-two"]);
    const grouped = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: secondWireValue,
      options: [
        {
          group: "quality-tier",
          name: "Quality Tier",
          options: [
            {
              value: firstWireValue,
              name: "Model One",
              description: "First choice",
              _meta: { rank: 1 },
              extensionField: ["retained"],
            },
            { value: secondWireValue, name: "Model Two" },
          ],
        },
        {
          group: "cost-tier",
          name: "Cost Tier",
          options: [
            {
              value: JSON.stringify(["vendor-b", "model-three"]),
              name: "Model Three",
            },
          ],
        },
      ],
    } as unknown as ConfigOption;

    const flattened = flattenConfigOptions([grouped])[0];
    assert.ok("options" in flattened);
    assert.equal(flattened.currentValue, secondWireValue);
    assert.deepEqual(
      flattened.options.map(({ value, name }) => ({ value, name })),
      [
        { value: firstWireValue, name: "Quality Tier/Model One" },
        { value: secondWireValue, name: "Quality Tier/Model Two" },
        {
          value: JSON.stringify(["vendor-b", "model-three"]),
          name: "Cost Tier/Model Three",
        },
      ],
    );
    assert.deepEqual(flattened.options[0], {
      value: firstWireValue,
      name: "Quality Tier/Model One",
      description: "First choice",
      _meta: { rank: 1 },
      extensionField: ["retained"],
    });
  });

  it("keeps an already-flat choice payload and its labels unchanged", () => {
    const flat: ConfigSelectOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "vendor-a/model-one",
      options: [{ value: "vendor-a/model-one", name: "vendor-a/Model One" }],
    };
    assert.strictEqual(flattenConfigOptions([flat])[0], flat);
  });
});
