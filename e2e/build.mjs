// Build the Electron app's .vite output the way `electron-forge package` does
// (same ViteConfigGenerator, same entries as forge.config.ts), without
// packaging. The e2e harness launches the plain electron binary on it.
import { createRequire } from 'node:module';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const ViteConfigGenerator = require('@electron-forge/plugin-vite/dist/ViteConfig').default;

// Keep in step with the VitePlugin block in forge.config.ts.
const pluginConfig = {
  build: [
    { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
    { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
    { entry: 'src/preload/quickLaunchPreload.ts', config: 'vite.preload.config.ts', target: 'preload' },
  ],
  renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
};

const gen = new ViteConfigGenerator(pluginConfig, process.cwd(), true);
const configs = [...(await gen.getBuildConfigs()), ...(await gen.getRendererConfig())];
for (const c of configs) {
  await build({ ...c, configFile: false, logLevel: 'warn' });
}
console.log(`e2e build: ${configs.length} vite builds done`);
