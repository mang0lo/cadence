// Bundles the Electron main process and preload script into dist/ (CommonJS, as Electron loads them).
import { build } from 'esbuild';

for (const name of ['main', 'preload']) {
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'warning',
  });
}
