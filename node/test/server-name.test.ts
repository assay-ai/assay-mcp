import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULE,
  MAX_NAME_LENGTH,
  NO_NAME_BUDGET,
  SIGNED_OUT_L,
  SIGN_IN_HINT,
  aliasTool,
  defaultName,
  fits,
  isValidName,
  longestTool,
  maxNameLength,
  refusal,
  unique,
  type ToolView,
  type UrlKind,
} from "../src/clients/server-name.js";

interface Vectors {
  rule: { budget: number; overhead: number; signedOutL: number; noNameBudget: number; maxLength: number; signedOutHint: string };
  maxLength: { name: string; L: number; max: number }[];
  valid: { name: string; ok: boolean }[];
  fits: { name: string; L: number; fits: boolean }[];
  longestTool: ({ name: string; L: number } & (
    | { mode: "search"; pinned: string[] }
    | { mode: "full"; tools: string[] }
    | { mode: "signedOut" }
  ))[];
  defaultName: { name: string; urlKind: UrlKind; slugWords: string[]; L: number; expect: string }[];
  unique: { name: string; base: string; taken: string[]; L: number; expect: string }[];
  refusal: { name: string; typed: string; L: number; message: string }[];
  alias: { name: string; server: string; tool: string; expect: string }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/server-names.json", import.meta.url)), "utf8"),
) as Vectors;

describe("server-name vectors", () => {
  it("constants equal the vector rule", () => {
    expect(DEFAULT_RULE).toEqual({ budget: vectors.rule.budget, overhead: vectors.rule.overhead });
    expect(SIGNED_OUT_L).toBe(vectors.rule.signedOutL);
    expect(NO_NAME_BUDGET).toBe(vectors.rule.noNameBudget);
    expect(MAX_NAME_LENGTH).toBe(vectors.rule.maxLength);
    expect(SIGN_IN_HINT).toBe(vectors.rule.signedOutHint);
  });

  it.each(vectors.maxLength)("max length: $name", ({ L, max }) => {
    expect(maxNameLength(L)).toBe(max);
  });

  it.each(vectors.valid)("valid: '$name'", ({ name, ok }) => {
    expect(isValidName(name)).toBe(ok);
  });

  it.each(vectors.fits)("fits: $name at L=$L", ({ name, L, fits: expected }) => {
    expect(fits(name, L)).toBe(expected);
  });

  it.each(vectors.longestTool)("L: $name", (v) => {
    expect(longestTool(v as ToolView)).toBe(v.L);
  });

  it.each(vectors.defaultName)("default: $name", (v) => {
    expect(defaultName(v.urlKind, v.slugWords, v.L)).toBe(v.expect);
  });

  it.each(vectors.unique)("unique: $name", (v) => {
    expect(unique(v.base, v.taken, v.L)).toBe(v.expect);
  });

  it.each(vectors.refusal)("refusal: $name", (v) => {
    expect(refusal(v.typed, v.L)).toBe(v.message);
  });

  it.each(vectors.alias)("alias: $name", (v) => {
    const alias = aliasTool(v.server, v.tool);
    expect(alias).toBe(v.expect);
    expect(DEFAULT_RULE.overhead + v.server.length + alias.length).toBeLessThanOrEqual(DEFAULT_RULE.budget);
    expect(aliasTool(v.server, v.tool)).toBe(alias);
  });
});

describe("server-name rule", () => {
  it('"/" search no pins: L 12 gives max 45', () => {
    expect(maxNameLength(12)).toBe(45);
    expect(fits("a".repeat(45), 12)).toBe(true);
    expect(fits("a".repeat(46), 12)).toBe(false);
  });

  it("/c/weather full, longest 20: max 37, and assay-weather fits", () => {
    expect(maxNameLength(20)).toBe(37);
    expect(fits("assay-weather", 20)).toBe(true);
  });

  it("a typed 40-character name on L=20 is refused with a suggestion", () => {
    const typed = "assay-weather-forecast-climate-data-tool";
    expect(typed).toHaveLength(40);
    expect(fits(typed, 20)).toBe(false);
    expect(refusal(typed, 20)).toContain("Try `assay-weather-forecast-climate-data`.");
  });

  it("signed out uses 48", () => {
    expect(longestTool({ mode: "signedOut" })).toBe(48);
  });

  it('"_" is refused', () => {
    expect(fits("_", 12)).toBe(false);
  });

  it("collision gives assay-weather-2", () => {
    expect(unique("assay-weather", ["assay-weather"], 20)).toBe("assay-weather-2");
  });

  it("an alias maps to a different name for different originals", () => {
    const server = "assay-weather-forecast-service";
    expect(aliasTool(server, "get_historical_weather_forecast_hourly_v2")).not.toBe(
      aliasTool(server, "get_historical_weather_forecast_hourly_v3"),
    );
  });
});
