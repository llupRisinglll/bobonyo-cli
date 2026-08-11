// Patch OpenTUI's tree-sitter WORKER resolution to use the asset root.
//
// In a `bun build --compile` binary, `import("@opentui/core/parser.worker",
// {with: {type: "file"}})` resolves to an empty object instead of a file
// path, so `resolveBundledFilePath` crashes with `undefined.startsWith`.
// Flipping `useAssetRoot` to true makes it load the worker from
// `OTUI_ASSET_ROOT/@opentui/core/parser.worker.js` (shipped next to the
// tree-sitter WASM).
import {readFileSync, writeFileSync} from 'node:fs';

const file = new URL(
	'../node_modules/@opentui/core/chunk-bun-t2myhmwd.js',
	import.meta.url,
);
const source = readFileSync(file, 'utf8');
const from = '{ useAssetRoot: false }';
const to = '{ useAssetRoot: true }';

if (source.includes(to)) {
	console.log('OpenTUI worker already patched');
	process.exit(0);
}
if (!source.includes(from)) {
	console.error('OpenTUI worker patch pattern not found');
	process.exit(1);
}
writeFileSync(file, source.replace(from, to, 1));
console.log('Patched OpenTUI tree-sitter worker resolution');
