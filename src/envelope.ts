export interface JsonOptions {
  readonly json: boolean;
}

export interface Envelope {
  readonly ok: boolean;
  readonly run: string | null;
  readonly step: string | null;
  readonly errors: readonly string[];
  readonly data?: Record<string, unknown>;
}

export interface HandlerResult {
  readonly code: number;
  readonly envelope: Envelope;
  readonly human: string;
}

export function ok(
  run: string | null,
  step: string | null,
  human: string,
  data?: Record<string, unknown>,
): HandlerResult {
  return { code: 0, envelope: { ok: true, run, step, errors: [], data }, human };
}

export function fail(
  code: number,
  run: string | null,
  step: string | null,
  errors: readonly string[],
  human?: string,
  data?: Record<string, unknown>,
): HandlerResult {
  const text = human ?? errors.join("\n");
  return { code, envelope: { ok: false, run, step, errors, data }, human: text };
}
