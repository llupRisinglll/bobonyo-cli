// Release build.
//
// NOTE: `bun build --compile` cannot produce a working standalone binary for
// this app — OpenTUI's Solid JSX transform plugin (preloaded by `bun run`)
// cannot be injected into the bun build pipeline (the API throws "src is a
// directory", the CLI has no plugin flag), so the compiled output hits the
// "Orphan text error". Until that is solvable, `dist/bobonyo` is the RELEASE
// LAUNCHER (runs the release entry via bun) and the asset copies are kept so
// a future binary fix can ship them.
import {
	mkdirSync,
	writeFileSync,
	cpSync,
	readFileSync,
	chmodSync,
} from 'node:fs';

mkdirSync('dist', {recursive: true});
const launcher = readFileSync(
	new URL('./launcher.sh', import.meta.url),
	'utf8',
);
writeFileSync('dist/bobonyo', launcher, 'utf8');
chmodSync('dist/bobonyo', 0o755);

// Keep the runtime assets (tree-sitter worker/WASM + native render lib) so a
// working compiled binary can load them via OTUI_ASSET_ROOT later.
mkdirSync('dist/assets/@opentui/core', {recursive: true});
mkdirSync('dist/assets/@opentui/core-linux-x64', {recursive: true});
mkdirSync('dist/assets/web-tree-sitter', {recursive: true});
cpSync(
	'node_modules/@opentui/core/parser.worker.js',
	'dist/assets/@opentui/core/parser.worker.js',
);
cpSync(
	'node_modules/@opentui/core-linux-x64/libopentui.so',
	'dist/assets/@opentui/core-linux-x64/libopentui.so',
);
cpSync(
	'node_modules/web-tree-sitter/tree-sitter.wasm',
	'dist/assets/web-tree-sitter/tree-sitter.wasm',
);

console.log('Built dist/bobonyo (release launcher) + assets');
