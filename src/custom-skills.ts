import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {configSearchDirs} from './project-paths';
import {cavemanMode} from './state';
import {parseCommandFile} from './custom-yaml';
import {parseArgumentSpecs, type ArgumentSpec} from './custom';

function findFiles(subdir: string): string[] {
	const files: string[] = [];
	for (const base of configSearchDirs()) {
		const dir = join(base, subdir);
		if (!existsSync(dir)) continue;
		const walk = (current: string): void => {
			for (const entry of readdirSync(current, {withFileTypes: true})) {
				const path = join(current, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.md')) files.push(path);
			}
		};
		walk(dir);
	}
	return files.sort();
}

export interface Skill {
	name: string;
	description: string;
	argumentHint?: string;
	arguments: ArgumentSpec[];
	subscribe?: string[];
	body: string;
	source: string;
}

function skillName(file: string): string {
	const marker = '/skills/';
	const relative = file.slice(file.lastIndexOf(marker) + marker.length);
	const parts = relative.split('/');
	const leaf = parts.at(-1) ?? '';
	if (/^SKILL\.md$/i.test(leaf)) return parts.at(-2) ?? 'skill';
	return relative.replace(/\.md$/i, '').replaceAll('/', ':');
}

/**
 * Harness-shipped skills read from `src/builtin/*.md` at runtime.
 * Reads the bundled markdown at runtime so a future caveman update is just a
 * file replacement; `null` if the file is missing/unreadable.
 */
export function builtinHerdrSkill(): Skill | null {
	try {
		const file = join(import.meta.dir, 'builtin', 'herdr.md');
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		return {
			name: 'herdr',
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			arguments: parseArgumentSpecs(frontmatter.arguments),
			body,
			source: file,
		};
	} catch {
		return null;
	}
}
export function builtinCavemanSkill(): Skill | null {
	try {
		const file = join(import.meta.dir, 'builtin', 'caveman.md');
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		return {
			name: 'caveman',
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			arguments: parseArgumentSpecs(frontmatter.arguments),
			body,
			source: file,
		};
	} catch {
		return null;
	}
}

function builtinSkills(): Skill[] {
	const root = join(import.meta.dir, 'builtin');
	try {
		const files = readdirSync(root, {withFileTypes: true})
			.filter(entry => entry.isDirectory())
			.flatMap(entry => {
				const direct = join(root, entry.name, 'SKILL.md');
				if (existsSync(direct)) return [direct];
				try {
					return readdirSync(join(root, entry.name), {withFileTypes: true})
						.filter(child => child.isDirectory())
						.map(child => join(root, entry.name, child.name, 'SKILL.md'))
						.filter(existsSync);
				} catch {
					return [];
				}
			});
		return files.flatMap(file => {
			try {
				const {frontmatter, body} = parseCommandFile(
					readFileSync(file, 'utf8'),
				);
				const name =
					typeof frontmatter.name === 'string'
						? frontmatter.name
						: (file.split('/').at(-2) ?? 'skill');
				return [
					{
						name,
						description:
							typeof frontmatter.description === 'string'
								? frontmatter.description
								: '',
						arguments: parseArgumentSpecs(frontmatter.arguments),
						argumentHint:
							typeof frontmatter['argument-hint'] === 'string'
								? frontmatter['argument-hint']
								: undefined,
						body,
						source: file,
					},
				] satisfies Skill[];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

export function loadSkills(): Skill[] {
	const skills = new Map<string, Skill>();
	// Bobonyo reads only Bobonyo-owned config folders. Users migrate a
	// Claude/Codex skill by copying it into `skills/<name>/SKILL.md`; Bobonyo
	// never reaches into another agent's private config folder.
	const builtinHerdr = builtinHerdrSkill();
	if (builtinHerdr) skills.set(builtinHerdr.name.toLowerCase(), builtinHerdr);
	const builtin = cavemanMode() ? builtinCavemanSkill() : null;
	if (builtin) skills.set(builtin.name.toLowerCase(), builtin);
	for (const skill of builtinSkills()) {
		if (!skills.has(skill.name.toLowerCase()))
			skills.set(skill.name.toLowerCase(), skill);
	}
	for (const file of findFiles('skills')) {
		const {frontmatter, body} = parseCommandFile(readFileSync(file, 'utf8'));
		const name =
			(typeof frontmatter.name === 'string' ? frontmatter.name : '') ||
			(file.endsWith('/SKILL.md') || file.endsWith('\\SKILL.md')
				? skillName(file)
				: (file.split('/').pop()?.replace(/\.md$/, '') ?? ''));
		const subscribe = frontmatter.subscribe;
		skills.set(name.toLowerCase(), {
			name,
			description:
				typeof frontmatter.description === 'string'
					? frontmatter.description
					: '',
			argumentHint:
				typeof frontmatter['argument-hint'] === 'string'
					? frontmatter['argument-hint']
					: undefined,
			arguments: parseArgumentSpecs(frontmatter.arguments),
			subscribe: Array.isArray(subscribe) ? subscribe.map(String) : undefined,
			body,
			source: file,
		});
	}
	return [...skills.values()];
}
