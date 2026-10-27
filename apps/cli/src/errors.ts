/** An expected failure whose message is shown to the user as-is, without a stack trace. */
export class KeelError extends Error {
  override name = "KeelError";
}

/** A keel API response that wasn't OK. `fromKeel` is false when the body isn't one of keel's errors. */
export class KeelApiError extends KeelError {
  override name = "KeelApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly fromKeel: boolean,
  ) {
    super(message);
  }

  /** The route doesn't exist on this keel server: an older version than the CLI expects. */
  get unsupported(): boolean {
    return this.status === 404 && !this.fromKeel;
  }
}
