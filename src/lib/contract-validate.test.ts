import { describe, expect, it } from "vitest";
import type { JSONSchema7 } from "json-schema";
import { validateOutputContract } from "./contract-validate.js";

const schemaFeatures: JSONSchema7 = {
  type: "object",
  required: ["features"],
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
};

describe("validateOutputContract", () => {
  describe("non-agent nodes (validate artifact directly)", () => {
    it("passes when payload conforms to schema", () => {
      expect(() =>
        validateOutputContract("break-down", "transform", schemaFeatures, {
          features: [{ id: "f1", title: "Feature 1" }],
        })
      ).not.toThrow();
    });

    it("throws with node id and errors when payload does not conform", () => {
      expect(() =>
        validateOutputContract("break-down", "transform", schemaFeatures, {
          features: "not-an-array",
        })
      ).toThrow(/break-down/);
      expect(() =>
        validateOutputContract("break-down", "transform", schemaFeatures, {
          features: "not-an-array",
        })
      ).toThrow(/schema|valid|required|features/i);
    });

    it("throws when required property is missing", () => {
      expect(() =>
        validateOutputContract("out", "transform", schemaFeatures, {})
      ).toThrow(/break-down|out/);
    });
  });

  describe("agent nodes (validate JSON.parse(artifact.text))", () => {
    it("passes when text is valid JSON conforming to schema", () => {
      const artifact = {
        text: JSON.stringify({ features: [{ id: "a", title: "A" }] }),
        tokenUsage: { input: 1, output: 2 },
      };
      expect(() =>
        validateOutputContract("writer", "agent", schemaFeatures, artifact)
      ).not.toThrow();
    });

    it("throws when text is not valid JSON", () => {
      const artifact = { text: "not json at all", tokenUsage: {} };
      expect(() =>
        validateOutputContract("writer", "agent", schemaFeatures, artifact)
      ).toThrow(/writer/);
      expect(() =>
        validateOutputContract("writer", "agent", schemaFeatures, artifact)
      ).toThrow(/JSON|parse/i);
    });

    it("throws when text is JSON but does not conform to schema", () => {
      const artifact = {
        text: JSON.stringify({ wrongKey: true }),
        tokenUsage: {},
      };
      expect(() =>
        validateOutputContract("writer", "agent", schemaFeatures, artifact)
      ).toThrow(/writer/);
      expect(() =>
        validateOutputContract("writer", "agent", schemaFeatures, artifact)
      ).toThrow(/schema|valid|required|features/i);
    });
  });
});
