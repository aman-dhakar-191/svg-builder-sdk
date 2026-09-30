// Picks the app version for this CI run and writes it to $GITHUB_OUTPUT.
//
// Releases are tagged vMAJOR.MINOR.PATCH. MAJOR.MINOR come from
// apps/desktop/package.json (bump them there by hand); PATCH goes up by one
// with every release. A commit that already has a release tag keeps it, so
// re-running a release is safe. Non-release builds get a prerelease version
// (next patch + "-dev.<run number>") so their installers are never mistaken
// for a release.
//
// Env: RELEASE ("true" on pushes to main), RUN_NUMBER.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const parse = (tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number) ?? null;
const byVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const base = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
const [major, minor, patch0] = base.split(/[.-]/).map(Number);
if (![major, minor, patch0].every(Number.isInteger)) throw new Error(`apps/desktop/package.json version "${base}" is not MAJOR.MINOR.PATCH`);

const onHead = git("tag", "--points-at", "HEAD", "--list", "v*").map(parse).filter(Boolean).sort(byVersion);
const patches = git("tag", "--list", `v${major}.${minor}.*`).map(parse).filter(Boolean).map((v) => v[2]);
const next = `${major}.${minor}.${patches.length ? Math.max(...patches) + 1 : patch0}`;

const release = process.env.RELEASE === "true";
let version;
if (release) version = onHead.length ? onHead.at(-1).join(".") : next;
else version = `${next}-dev.${process.env.RUN_NUMBER ?? "0"}`;

console.log(`version=${version} release=${release}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nrelease=${release}\n`);
