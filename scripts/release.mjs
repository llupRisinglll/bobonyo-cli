#!/usr/bin/env node
// Change-set release driver.
//
// Consumes `.changeset/*.md` entries (one per non-release commit, see
// `.changeset/README.md`), bumps package.json's `version`, prepends the
// generated section to CHANGELOG.md, and deletes the consumed entries.
// `.github/workflows/release.yml` runs this on `main` and publishes the
// GitHub Release; `src/version.ts` reads the bumped version at runtime.
//
// Usage:
//   node scripts/release.mjs                    consume + write (release run)
//   node scripts/release.mjs --dry-run          print the plan, write nothing
//   node scripts/release.mjs --notes <file>     also write release notes
//   node scripts/release.mjs --require-changeset <base>
//       CI guard: fail when source files changed since <base> without a
//       valid change set in the same range (PR-only).
//
// Outputs (when $GITHUB_OUTPUT is set): released=true|false, version=X.Y.Z.
import {execFileSync} from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const changesetDir = join(root, '.changeset');
const packagePath = join(root, 'package.json');
const changelogPath = join(root, 'CHANGELOG.md');

const LEVELS = ['major', 'minor', 'patch'];
const RANK = {major: 3, minor: 2, patch: 1};

/** Parse one change-set file: frontmatter level + summary body. */
function parseChangeset(name, text) {
	const body = text.trim();
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body);
	if (!match) {
		throw new Error(
			`.changeset/${name}: missing frontmatter (expected "---" ... "---" block)`,
		);
	}
	let level;
	for (const line of match[1].split(/\r?\n/)) {
		if (!line.trim()) continue;
		// Either quote style: formatters (prettier's YAML frontmatter pass)
		// rewrite `"bobonyo"` to 'bobonyo' on commit.
		const pair = /^\s*(['"])([^'"]+)\1\s*:\s*([a-z]+)\s*$/.exec(line);
		if (!pair) {
			throw new Error(
				`.changeset/${name}: malformed frontmatter line: ${line}`,
			);
		}
		if (pair[2] !== 'bobonyo') {
			throw new Error(
				`.changeset/${name}: unknown package "${pair[2]}" (expected "bobonyo")`,
			);
		}
		if (!LEVELS.includes(pair[3])) {
			throw new Error(
				`.changeset/${name}: invalid level "${pair[3]}" (use major/minor/patch)`,
			);
		}
		level = pair[3];
	}
	const summary = (match[2] ?? '').trim();
	if (!level)
		throw new Error(`.changeset/${name}: no version level in frontmatter`);
	if (!summary) throw new Error(`.changeset/${name}: empty summary`);
	return {name, level, summary};
}

/** All pending change sets, sorted by file name. */
function collectChangesets() {
	if (!existsSync(changesetDir)) return [];
	return readdirSync(changesetDir)
		.filter(file => file.endsWith('.md') && file !== 'README.md')
		.sort()
		.map(file =>
			parseChangeset(file, readFileSync(join(changesetDir, file), 'utf8')),
		);
}

function bumpVersion(current, level) {
	const parts = current.split('.').map(Number);
	if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) {
		throw new Error(`package.json: cannot parse version "${current}"`);
	}
	const [major, minor, patch] = parts;
	if (level === 'major') return `${major + 1}.0.0`;
	if (level === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

/** Build the `## vX.Y.Z (date)` changelog/release section. */
function releaseSection(version, entries) {
	const lines = [`## v${version} (${today()})`, ''];
	for (const level of ['major', 'minor', 'patch']) {
		const group = entries.filter(entry => entry.level === level);
		if (group.length === 0) continue;
		lines.push(
			`### ${level === 'major' ? 'Major' : level === 'minor' ? 'Minor' : 'Patch'}`,
		);
		for (const entry of group) lines.push(`- ${entry.summary}`);
		lines.push('');
	}
	return lines.join('\n');
}

function emitOutputs(released, version) {
	const target = process.env.GITHUB_OUTPUT;
	if (!target) return;
	appendFileSync(target, `released=${released}\nversion=${version}\n`);
}

function requireChangeset(base) {
	let changed;
	try {
		changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
			cwd: root,
			encoding: 'utf8',
		});
	} catch (error) {
		console.error(`release.mjs: git diff against ${base} failed`);
		process.exit(1);
	}
	const files = changed.split('\n').filter(Boolean);
	const sourceChanged = files.some(
		file =>
			/^(src|scripts)\//.test(file) ||
			file === 'package.json' ||
			file === 'bun.lock' ||
			file === 'tsconfig.json',
	);
	const changesetFiles = files.filter(
		file =>
			/^\.changeset\/.+\.md$/.test(file) &&
			file !== '.changeset/README.md' &&
			existsSync(join(root, file)),
	);
	// Malformed entries must never reach main: validate every changed one.
	for (const file of changesetFiles) {
		parseChangeset(
			file.slice('.changeset/'.length),
			readFileSync(join(root, file), 'utf8'),
		);
	}
	if (sourceChanged && changesetFiles.length === 0) {
		console.error(
			'This range changes source/build files but adds no change set.\n' +
				'Add one .changeset/<slug>.md per commit (see .changeset/README.md):\n' +
				'  ---\n  "bobonyo": patch\n  ---\n  One-line summary.',
		);
		process.exit(1);
	}
	console.log(
		`changeset check ok (${files.length} changed files, ${changesetFiles.length} change set(s))`,
	);
}

const args = process.argv.slice(2);
if (args[0] === '--require-changeset') {
	if (!args[1]) {
		console.error('usage: release.mjs --require-changeset <base-ref>');
		process.exit(1);
	}
	requireChangeset(args[1]);
	process.exit(0);
}

const dryRun = args.includes('--dry-run');
const notesIndex = args.indexOf('--notes');
const notesPath = notesIndex >= 0 ? args[notesIndex + 1] : undefined;

const entries = collectChangesets();
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const current = pkg.version;

const publishedTags = execFileSync('git', ['tag', '--list', 'v*'], {
	cwd: root,
	encoding: 'utf8',
})
	.trim()
	.split('\n')
	.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
	.map(tag => tag.slice(1))
	.sort((left, right) => {
		const a = left.split('.').map(Number);
		const b = right.split('.').map(Number);
		return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
	});
if (publishedTags.length > 0 && publishedTags[0] !== current) {
	throw new Error(
		`Version drift: package.json is ${current}, latest release tag is v${publishedTags[0]}. Reconcile version before consuming change sets.`,
	);
}

if (entries.length === 0) {
	console.log(`release.mjs: no pending change sets (version stays ${current})`);
	emitOutputs(false, current);
	process.exit(0);
}

const level = entries.reduce(
	(best, entry) => (RANK[entry.level] > RANK[best] ? entry.level : best),
	'patch',
);
const version = bumpVersion(current, level);
const section = releaseSection(version, entries);

// Never silently reuse a released version: stale package.json state must be
// reconciled with tags before a new release can proceed.
const existingTag = execFileSync('git', ['tag', '--list', `v${version}`], {
	cwd: root,
	encoding: 'utf8',
}).trim();
if (existingTag) {
	throw new Error(
		`Refusing release: v${version} already exists. Reconcile package.json version with release tags first.`,
	);
}

console.log(
	`release.mjs: ${entries.length} change set(s) → ${current} → ${version} (${level})`,
);
for (const entry of entries) console.log(`  [${entry.level}] ${entry.summary}`);

if (dryRun) {
	emitOutputs(false, current);
	process.exit(0);
}

pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, '\t')}\n`);
const changelog = existsSync(changelogPath)
	? readFileSync(changelogPath, 'utf8')
	: '# Changelog\n\nAll notable changes to bobonyo. Generated from `.changeset/` entries by `scripts/release.mjs`.\n';
const marker = '\n## ';
const insertAt = changelog.indexOf(marker);
const next =
	insertAt === -1
		? `${changelog.trimEnd()}\n\n${section}`
		: `${changelog.slice(0, insertAt).trimEnd()}\n\n${section}${changelog.slice(insertAt + 1)}`;
writeFileSync(changelogPath, next.endsWith('\n') ? next : `${next}\n`);
for (const entry of entries) unlinkSync(join(changesetDir, entry.name));
if (notesPath) writeFileSync(notesPath, section);

console.log(`release.mjs: released v${version}`);
emitOutputs(true, version);
