#!/usr/bin/env node
/**
 * Binnacle one-command setup.
 *
 *   npm run setup
 *
 * Takes a fresh clone to a live, private wiki on Cloudflare's free tier. It:
 *   1. confirms you're logged into Cloudflare (triggers `wrangler login` if not),
 *   2. creates the `binnacle` D1 database (or reuses it) and writes the id into
 *      wrangler.toml,
 *   3. applies the schema migrations to the remote database,
 *   4. deploys the Worker,
 *   5. generates a strong AUTH_TOKEN and stores it as a Worker secret,
 *   6. prints your URL + token so you can connect Claude.
 *
 * Safe to re-run: an existing database is reused, and it will ask before
 * overwriting an AUTH_TOKEN that already looks set.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOML = join(ROOT, "wrangler.toml");
const WRANGLER = "npx --yes wrangler@latest";
const DB_NAME = "binnacle";

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let STEP = 0;
const step = (msg) => console.log(`\n${c.cyan(`[${++STEP}]`)} ${c.b(msg)}`);
const info = (msg) => console.log(`    ${c.dim(msg)}`);
const die = (msg) => {
  console.error(`\n${c.red("✗")} ${msg}\n`);
  process.exit(1);
};

// Run a command, inheriting the terminal (for interactive login/deploy).
function run(cmd) {
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) die(`Command failed: ${cmd}`);
}

// Run a command and capture stdout (for parsing wrangler output).
function capture(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    return (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  }
}

async function main() {
  console.log(c.b("\n🧭  Binnacle setup\n"));
  console.log("This will create a D1 database, deploy the Worker, and set your access token.");
  console.log(c.dim("Everything lands on your own Cloudflare account. Ctrl-C to bail anytime."));

  // 1. Cloudflare auth ------------------------------------------------------
  step("Checking Cloudflare login");
  const who = capture(`${WRANGLER} whoami`);
  if (/You are not authenticated/i.test(who) || /not logged in/i.test(who)) {
    info("Not logged in — opening the Cloudflare login flow…");
    run(`${WRANGLER} login`);
  } else {
    const email = who.match(/associated with the email ['"]?([^'".\s]+@[^'".\s]+)/i);
    info(email ? `Logged in as ${email[1]}` : "Logged in.");
  }

  // 2. D1 database ----------------------------------------------------------
  step("Creating the D1 database");
  let toml = readFileSync(TOML, "utf8");
  let dbId = findExistingDbId();
  if (dbId) {
    info(`Reusing existing "${DB_NAME}" database (${dbId}).`);
  } else {
    const out = capture(`${WRANGLER} d1 create ${DB_NAME}`);
    dbId = (out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i) || [])[1];
    if (!dbId) {
      // Creation may have raced or the name may already exist — look it up.
      dbId = findExistingDbId();
    }
    if (!dbId) die(`Could not create or find the "${DB_NAME}" D1 database.\n${out}`);
    info(`Database ready (${dbId}).`);
  }

  // Write the id into wrangler.toml.
  const patched = toml.replace(
    /(database_id\s*=\s*")[^"]*(")/,
    `$1${dbId}$2`
  );
  if (patched !== toml) {
    writeFileSync(TOML, patched);
    info("Wrote database_id into wrangler.toml.");
  }

  // 3. Migrations -----------------------------------------------------------
  step("Applying schema migrations");
  run(`${WRANGLER} d1 migrations apply ${DB_NAME} --remote`);

  // 4. Deploy ---------------------------------------------------------------
  step("Deploying the Worker");
  const deployOut = captureAndEcho(`${WRANGLER} deploy`);
  const url =
    (deployOut.match(/https:\/\/[a-z0-9.-]*\.workers\.dev/i) || [])[0] ||
    (deployOut.match(/https:\/\/\S+/i) || [])[0] ||
    "https://binnacle.<your-subdomain>.workers.dev";

  // 5. AUTH_TOKEN secret ----------------------------------------------------
  step("Setting your access token");
  const existing = capture(`${WRANGLER} secret list`);
  let token = null;
  if (/AUTH_TOKEN/.test(existing)) {
    const rl = createInterface({ input, output });
    const ans = (
      await rl.question(
        `    ${c.yellow("AUTH_TOKEN already exists.")} Generate a new one and overwrite it? [y/N] `
      )
    ).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      info("Keeping the existing token.");
    } else {
      token = generateToken();
    }
  } else {
    token = generateToken();
  }

  if (token) {
    const r = spawnSync(`${WRANGLER} secret put AUTH_TOKEN`, {
      input: token + "\n",
      stdio: ["pipe", "inherit", "inherit"],
      shell: true,
    });
    if (r.status !== 0) die("Failed to set the AUTH_TOKEN secret.");
  }

  // Done --------------------------------------------------------------------
  console.log(`\n${c.green("✓ Binnacle is live.")}\n`);
  console.log(`  ${c.b("Reader:")}  ${url}`);
  console.log(`  ${c.b("MCP:")}     ${url}/mcp`);
  if (token) {
    console.log(`\n  ${c.b("Access token")} ${c.dim("(shown once — save it in your password manager):")}`);
    console.log(`\n    ${c.yellow(token)}\n`);
  } else {
    console.log(`\n  ${c.dim("Using your existing AUTH_TOKEN. Reset it with:")} ${WRANGLER} secret put AUTH_TOKEN\n`);
  }
  console.log(`  ${c.b("Connect Claude Code:")}`);
  console.log(
    c.dim(
      `    claude mcp add --scope user --transport http binnacle \\\n` +
        `      ${url}/mcp --header "Authorization: Bearer <token>"`
    )
  );
  console.log(`\n  ${c.dim("Then open the reader, log in with the same token, and start writing.")}\n`);
}

function findExistingDbId() {
  const listJson = capture(`${WRANGLER} d1 list --json`);
  try {
    const arr = JSON.parse(listJson.slice(listJson.indexOf("[")));
    const hit = arr.find((d) => d.name === DB_NAME);
    if (hit) return hit.uuid || hit.database_id || null;
  } catch {
    /* not JSON (older wrangler / error) — fall through */
  }
  return null;
}

function generateToken() {
  return randomBytes(32).toString("base64url");
}

// Run a command, stream it to the terminal, AND capture stdout for parsing.
function captureAndEcho(cmd) {
  const out = capture(cmd);
  process.stdout.write(out);
  return out;
}

main().catch((e) => die(e?.message || String(e)));
