#!/usr/bin/env node
import { spawn } from "node:child_process";

const rawArgs = process.argv.slice(2);
let mode = "local";
const passThrough = [];

function usage() {
  console.log(`Usage:
  npm run build:native [-- <tauri build args>]
  npm run build:native:signed [-- <tauri build args>]

Modes:
  --local    Build local app/installers without updater artifacts. Default.
  --signed   Build release app/installers with updater artifacts and signing.

Local builds do not require TAURI_SIGNING_PRIVATE_KEY. Signed builds require it.`);
}

for (const arg of rawArgs) {
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--local") {
    mode = "local";
    continue;
  }
  if (arg === "--signed" || arg === "--release") {
    mode = "signed";
    continue;
  }
  passThrough.push(arg);
}

const hasUpdaterKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());
const tauriArgs = ["tauri", "build", ...passThrough];

if (mode === "signed") {
  if (!hasUpdaterKey) {
    console.error(
      "TAURI_SIGNING_PRIVATE_KEY is required for signed release builds.",
    );
    console.error(
      "For local packaging without updater artifacts, run: npm run build:native",
    );
    process.exit(1);
  }
  console.log("Building signed native release with updater artifacts...");
} else {
  tauriArgs.push(
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  );
  console.log("Building local native package without updater artifacts...");
  if (hasUpdaterKey) {
    console.log(
      "TAURI_SIGNING_PRIVATE_KEY is set, but local mode disables updater artifacts. Use npm run build:native:signed for release artifacts.",
    );
  }
}

const bin = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(bin, tauriArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
