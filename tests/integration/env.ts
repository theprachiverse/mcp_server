import { findProjectRoot, loadDotEnv } from "../../src/config.js";

loadDotEnv(findProjectRoot());

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const e = process.env;

/** Docs tests run when the master switch and a test document are configured. */
export const docsEnabled = e.RUN_INTEGRATION_TESTS === "1" && !!e.INTEGRATION_TEST_DOC_ID;

/** Email tests need a second explicit flag and an allow-listed recipient. */
export const emailEnabled =
  e.RUN_INTEGRATION_TESTS === "1" &&
  e.RUN_INTEGRATION_EMAIL_TESTS === "1" &&
  !!e.INTEGRATION_TEST_RECIPIENT &&
  list(e.INTEGRATION_RECIPIENT_ALLOWLIST).includes(e.INTEGRATION_TEST_RECIPIENT.toLowerCase());

export const TEST_DOC_ID = e.INTEGRATION_TEST_DOC_ID ?? "";
export const READONLY_DOC_ID = e.INTEGRATION_READONLY_DOC_ID ?? "";
export const TEST_RECIPIENT = e.INTEGRATION_TEST_RECIPIENT ?? "";
