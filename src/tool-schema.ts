export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case 'object':
			return (
				typeof value === 'object' && value !== null && !Array.isArray(value)
			);
		case 'array':
			return Array.isArray(value);
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'null':
			return value === null;
		default:
			return true;
	}
}

function validateNode(
	value: unknown,
	schema: unknown,
	path: string,
	errors: string[],
): void {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
	const rule = schema as Record<string, unknown>;
	if (Array.isArray(rule.oneOf)) {
		const matches = rule.oneOf.filter(candidate => {
			const nested: string[] = [];
			validateNode(value, candidate, path, nested);
			return nested.length === 0;
		});
		if (matches.length !== 1)
			errors.push(`${path} must match exactly one allowed schema`);
		return;
	}
	if (Array.isArray(rule.anyOf)) {
		const matches = rule.anyOf.some(candidate => {
			const nested: string[] = [];
			validateNode(value, candidate, path, nested);
			return nested.length === 0;
		});
		if (!matches) errors.push(`${path} must match an allowed schema`);
		return;
	}
	if (typeof rule.type === 'string' && !typeMatches(value, rule.type)) {
		errors.push(`${path} must be ${rule.type}`);
		return;
	}
	if (
		Array.isArray(rule.enum) &&
		!rule.enum.some(candidate => Object.is(candidate, value))
	) {
		errors.push(`${path} must be one of ${rule.enum.map(String).join(', ')}`);
	}
	if (typeof value === 'string') {
		if (typeof rule.minLength === 'number' && value.length < rule.minLength)
			errors.push(`${path} must contain at least ${rule.minLength} characters`);
		if (typeof rule.maxLength === 'number' && value.length > rule.maxLength)
			errors.push(`${path} must contain at most ${rule.maxLength} characters`);
		if (typeof rule.pattern === 'string') {
			try {
				if (!new RegExp(rule.pattern).test(value))
					errors.push(`${path} has invalid format`);
			} catch {
				errors.push(`${path} schema has invalid pattern`);
			}
		}
	}
	if (typeof value === 'number') {
		if (typeof rule.minimum === 'number' && value < rule.minimum)
			errors.push(`${path} must be >= ${rule.minimum}`);
		if (typeof rule.maximum === 'number' && value > rule.maximum)
			errors.push(`${path} must be <= ${rule.maximum}`);
	}
	if (Array.isArray(value)) {
		if (typeof rule.minItems === 'number' && value.length < rule.minItems)
			errors.push(`${path} must contain at least ${rule.minItems} items`);
		if (typeof rule.maxItems === 'number' && value.length > rule.maxItems)
			errors.push(`${path} must contain at most ${rule.maxItems} items`);
		if (rule.items)
			value.forEach((item, index) =>
				validateNode(item, rule.items, `${path}[${index}]`, errors),
			);
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const object = value as Record<string, unknown>;
		const properties =
			rule.properties &&
			typeof rule.properties === 'object' &&
			!Array.isArray(rule.properties)
				? (rule.properties as Record<string, unknown>)
				: {};
		for (const required of Array.isArray(rule.required) ? rule.required : []) {
			if (typeof required === 'string' && !(required in object))
				errors.push(`${path}.${required} is required`);
		}
		for (const [key, item] of Object.entries(object)) {
			if (key in properties)
				validateNode(item, properties[key], `${path}.${key}`, errors);
			else if (rule.additionalProperties === false)
				errors.push(`${path}.${key} is not allowed`);
			else if (
				rule.additionalProperties &&
				typeof rule.additionalProperties === 'object'
			)
				validateNode(item, rule.additionalProperties, `${path}.${key}`, errors);
		}
	}
}

export function validateToolArguments(
	value: unknown,
	schema: Record<string, unknown> | undefined,
): ValidationResult {
	if (!schema) return {valid: true, errors: []};
	const errors: string[] = [];
	validateNode(value, schema, '$', errors);
	return {valid: errors.length === 0, errors};
}
