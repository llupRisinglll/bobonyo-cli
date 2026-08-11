import type {JSX as OpenTuiJSX} from '@opentui/solid/jsx-runtime';

declare global {
	namespace JSX {
		type Element = OpenTuiJSX.Element;
		interface IntrinsicElements extends OpenTuiJSX.IntrinsicElements {}
		interface ElementChildrenAttribute {
			children: {};
		}
	}
}

export {};
