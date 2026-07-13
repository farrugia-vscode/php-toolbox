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

async function run(): Promise<void> {
  if (isWatch) {
    const context = await esbuild.context(extensionConfig);
    await context.watch();
    return;
  }
  await esbuild.build(extensionConfig);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
