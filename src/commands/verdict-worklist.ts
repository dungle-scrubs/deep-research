import { readClaimsFile } from "../report.js";
import { readState } from "../state.js";
import { unresolvedVerdictClaims } from "../verdicts.js";

/** The engine owns outstanding pair identity and accepted conflict history.
 * Drivers consume the worklist; matrix status is never a completion test. */
export function verdictWorklist(run: string): ReturnType<typeof unresolvedVerdictClaims> {
  const state = readState(run);
  return unresolvedVerdictClaims(readClaimsFile(run), state.verdictBatches?.flat() ?? [], run);
}
