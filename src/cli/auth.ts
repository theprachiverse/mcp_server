import { spawn } from "node:child_process";
import { findProjectRoot, loadConfig, loadDotEnv, ConfigError } from "../config.js";
import { TokenStore } from "../auth/token-store.js";
import { getStatus, revoke, runConsentFlow } from "../auth/google-oauth.js";

const HELP = `Usage:
  npm run auth                 Authorize this server to use your Google account
  npm run auth -- --status     Show the authorized account, scopes and expiry
  npm run auth -- --revoke     Revoke access at Google and delete the local token file
`;

function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd as string, args as string[], {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed too */
  }
}

async function main(): Promise<number> {
  const flag = process.argv[2];
  if (flag === "--help" || flag === "-h") {
    console.log(HELP);
    return 0;
  }
  if (flag && !["--status", "--revoke"].includes(flag)) {
    console.error(`Unknown option: ${flag}\n${HELP}`);
    return 2;
  }
  const root = findProjectRoot();
  loadDotEnv(root);
  const config = loadConfig(process.env, root);
  const store = new TokenStore(config.tokenPath);

  if (flag === "--status") {
    const s = await getStatus(config, store);
    if (!s.authorized) {
      console.log("Not authorized. Run `npm run auth`.");
      return 1;
    }
    console.log(`Authorized account: ${s.email ?? "(unknown, offline or token revoked)"}`);
    console.log(`Scopes: ${s.scopes.join(", ")}`);
    if (s.expiry) console.log(`Access token expires: ${s.expiry} (refreshed automatically)`);
    console.log(`Token file: ${store.path}`);
    return 0;
  }
  if (flag === "--revoke") {
    const r = await revoke(config, store);
    if (!r.deleted && !r.revoked) console.log("Nothing to revoke.");
    else
      console.log(
        `Revoked at Google: ${r.revoked ? "yes" : "no (could not reach Google)"}. Local token file removed: ${r.deleted ? "yes" : "no"}.`,
      );
    return 0;
  }

  const result = await runConsentFlow(config, store, { openBrowser, log: (m) => console.log(m) });
  console.log(`\nAuthorized${result.email ? ` as ${result.email}` : ""}.`);
  console.log(`Token saved to: ${store.path}`);
  console.log("This server will act as that Google account for Gmail and Google Docs.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) console.error(err.message);
    else
      console.error(
        `Authorization failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    process.exit(1);
  },
);
