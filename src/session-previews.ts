import type {ChatMessage} from './state';

export function firstMessagePreview(messages: ChatMessage[]): string {
	const user = messages.find(message => message.role === 'user');
	const text = user?.content.trim() ?? '(empty conversation)';
	return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export function lastMessagePreview(messages: ChatMessage[]): string {
	const user = [...messages].reverse().find(message => message.role === 'user');
	const text = user?.content.trim() ?? '(empty conversation)';
	return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
