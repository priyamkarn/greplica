#!/usr/bin/env node

const supportedNodeRange = "22-26";
const version = parseNodeVersion(process.versions.node);

if (!isSupportedNodeVersion(version)) {
  console.error(`Greplica requires Node.js ${supportedNodeRange}.`);
  console.error(`Current Node.js version: ${process.version}.`);
  console.error("");
  console.error("Install or switch to Node 22, 23, 24, 25, or 26 before installing Greplica.");
  console.error("This requirement comes from Greplica's local embedding runtime and native SQLite dependencies.");
  process.exit(1);
}

function parseNodeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSupportedNodeVersion(version) {
  if (version === undefined) return false;
  return version.major >= 22 && version.major < 27;
}
