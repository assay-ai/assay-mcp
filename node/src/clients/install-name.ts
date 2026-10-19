/**
 * The server name `add` uses (spec 8.3.1 through Task 2.10's rule), per scope.
 *
 * A project config carries no `--name` (R-MU-4), so the proxy budgets for a 16-character name
 * (`NO_NAME_BUDGET`). A project-scope name must therefore fit that budget too: the rule is run
 * with `L' = max(L, 64 - 7 - 16)`, which caps the name at 16 characters.
 */
import type { Scope } from "./install-command.js";
import { DEFAULT_RULE, NO_NAME_BUDGET, defaultName, fits, maxNameLength, refusal, suggest, unique } from "./server-name.js";

/** The L the name rule runs with: L itself in user scope; at least 41 (a 16-character name) in project scope. */
export function nameRuleL(L: number, scope: Scope): number {
  return scope === "project" ? Math.max(L, DEFAULT_RULE.budget - DEFAULT_RULE.overhead - NO_NAME_BUDGET) : L;
}

export type NameChoice = { ok: true; name: string } | { ok: false; message: string };

export interface NameInputs {
  scope: Scope;
  /** L(u), measured or the signed-out 48. */
  L: number;
  /** `{slug}` words of the URL; empty for the plain root. */
  slugWords: readonly string[];
  /** Names the client config already has. */
  taken: readonly string[];
  /** `--name`, when given. */
  typed?: string;
}

/**
 * A typed name is checked, never changed: it is refused with 2.10's `refusal` when it does not
 * fit the URL, and with the 16-character project message (and 2.10's `suggest`) when it fits
 * the URL but not the project budget. The default is `assay` / `assay-{slug}` dropping words,
 * then made unique with `-2`, `-3`, ..., all within the scope's budget.
 */
export function chooseName({ scope, L, slugWords, taken, typed }: NameInputs): NameChoice {
  const ruleL = nameRuleL(L, scope);
  if (typed !== undefined) {
    if (!fits(typed, L)) return { ok: false, message: refusal(typed, L) };
    if (!fits(typed, ruleL)) {
      const s = suggest(typed, ruleL);
      return {
        ok: false,
        message:
          `\`${typed}\` is too long for a project config: it carries no --name, so assay-mcp budgets ` +
          `${maxNameLength(ruleL)} characters for the name.${s === null ? "" : ` Try \`${s}\`.`}`,
      };
    }
    return { ok: true, name: typed };
  }
  const base = defaultName(slugWords.length === 0 ? "ROOT" : "CATEGORY", slugWords, ruleL);
  return { ok: true, name: unique(base, taken, ruleL) };
}
