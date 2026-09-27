import {
	listMentionPaths,
	mentionPathText,
	mentionSearchToken,
	mentionToken,
} from '../mentions';
import {commandNames, customCommandNames} from '../commands';
import {loadSkills} from '../custom';
import {fuzzyScore} from './input-box-helpers';
import {slashToken} from './input-box-slash';

/**
 * Command-completion popup height (borders + match rows), the popup renders
 * ABOVE the input box, so the App subtracts it from the history height.
 */
export function completionPopupHeight(inputText: string, _width = 100): number {
	const name = slashToken(inputText);
	if (name === null) return 0;
	const all: string[] = [
		...commandNames(),
		...customCommandNames(),
		...loadSkills().map(skill => skill.name),
	];
	const matches: Array<{command: string; score: number}> = name
		? all
				.map(command => ({
					command,
					score: fuzzyScore(name.toLowerCase(), command),
				}))
				.filter(entry => entry.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 50)
		: all.slice(0, 6).map(command => ({command, score: 1}));
	// Borderless + windowed: one line per suggestion.
	return matches.length > 0 ? Math.min(6, matches.length) : 0;
}

/** `@` file-mention popup height (borders + match rows). */
export function mentionPopupHeight(inputText: string): number {
	const token = mentionToken(inputText);
	if (token === null) return 0;
	const all = listMentionPaths(token);
	const cwd = process.cwd();
	const q = mentionSearchToken(token).toLowerCase();
	const matches = q
		? all
				.filter(path => {
					const mention = mentionPathText(path, cwd);
					return Math.max(fuzzyScore(q, mention), fuzzyScore(q, path)) > 0;
				})
				.slice(0, 6)
		: all.slice(0, 6);
	return matches.length > 0 ? matches.length + 2 : 0;
}
