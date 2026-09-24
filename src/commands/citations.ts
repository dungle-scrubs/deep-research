import { CitationsUnavailableError, renderCitations, type CitationsExport } from "../citations.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { loadStateOrFail } from "./shared.js";

/** dr citations: the structured citation export for a run. Read-only;
 *  works on closed runs. Human output is the export JSON itself (it is
 *  a data export); --json wraps it in the standard envelope. */
export async function cmdCitations(
  runDir: string,
  format: string | undefined,
): Promise<HandlerResult> {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  if (format !== undefined && format !== "json") {
    return fail(
      1,
      runDir,
      loaded.state.step,
      [`E105: unknown format ${format}; supported: json`],
      `Unknown format: ${format}. Supported: json.`,
    );
  }
  let export_: CitationsExport;
  try {
    export_ = renderCitations(runDir, new Date().toISOString());
  } catch (error) {
    if (error instanceof CitationsUnavailableError) {
      return fail(1, runDir, loaded.state.step, [`E104: ${error.message}`], error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, loaded.state.step, [`E401: cannot render citations: ${message}`]);
  }
  const human = JSON.stringify(export_, null, 2);
  return ok(runDir, loaded.state.step, human, { citations: export_ });
}
