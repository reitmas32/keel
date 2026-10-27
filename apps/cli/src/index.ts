import * as p from "@clack/prompts";
import { KeelError } from "./errors.js";
import { buildProgram } from "./program.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof KeelError)) throw error;
  p.log.error(error.message);
  process.exitCode = 1;
}
