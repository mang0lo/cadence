// Bundles the server (and its import worker, which is the same entry) into dist/index.js.
// Everything is bundled except Node built-ins, so dist/ can be copied anywhere next to a Node runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  define: { __CADENCE_VERSION__: JSON.stringify(pkg.version) },
  // Some CommonJS dependencies call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __cadenceCreateRequire } from 'node:module'; const require = __cadenceCreateRequire(import.meta.url);",
  },
  // the offline gazetteer is embedded: src/lib/places/data.ts reads it from disk when running from source
  loader: { '.gz': 'binary' },
  plugins: [
    {
      name: 'embed-places',
      setup(b) {
        b.onLoad({ filter: /[\\/]lib[\\/]places[\\/]data\.ts$/ }, (args) => ({
          contents: "import bytes from './places.bin.gz';\nexport function placesBytes() { return bytes; }\n",
          loader: 'ts',
          resolveDir: path.dirname(args.path),
        }));
      },
    },
  ],
  logLevel: 'info',
});
