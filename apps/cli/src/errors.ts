/** An expected failure whose message is shown to the user as-is, without a stack trace. */
export class KeelError extends Error {
  override name = "KeelError";
}
