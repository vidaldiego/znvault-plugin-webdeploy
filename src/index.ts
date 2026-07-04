// Path: src/index.ts
export { createWebdeployCLIPlugin } from './cli.js';
export type { CLIPlugin, CLIPluginContext } from './cli/plugin-types.js';
import createWebdeployCLIPlugin from './cli.js';
export default createWebdeployCLIPlugin;
