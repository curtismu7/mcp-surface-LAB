// A refusal from the caller or the engine: becomes a short JSON error with an HTTP status, never a stack trace.
// Messages are fixed text and never echo the caller's input (a credential typed into a field must not come back in an error).
// `data` is optional extra detail the engine itself computed (never the caller's text): the JSON-RPC error and the operator view of a refused call.
export class InputError extends Error {
  constructor(code, message, status = 400, data = undefined) { super(message); this.code = code; this.status = status; this.data = data; }
}
export const refuse = (code, message, status = 400, data = undefined) => new InputError(code, message, status, data);
