import { afterAll } from "vitest";
import { closeTestDbs } from "./testing";

// Runs in every server test file (vitest.config.ts): closes the databases its test contexts opened.
afterAll(closeTestDbs);
