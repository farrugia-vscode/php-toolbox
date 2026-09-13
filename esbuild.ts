import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig: esbuild.BuildOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/** The usages panel runs in a browser, so it gets a bundle of its own, with no Node in it. */
const webviewConfig: esbuild.BuildOptions = {
  entryPoints: ['src/webview/usages.ts'],
  outfile: 'out/usages.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2021',
  sourcemap: true,
  logLevel: 'info',
};

async function run(): Promise<void> {
  if (isWatch) {
    const contexts = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
