import { build } from 'esbuild';

const host = process.env.PARTYKIT_HOST;
if (!host) {
  console.error('PARTYKIT_HOST env var is required for production build.');
  console.error('Set it to your deployed PartyKit URL, e.g. dotsandboxes.yourname.partykit.dev');
  process.exit(1);
}

await build({
  entryPoints: ['public/src/client.ts', 'public/src/landing.ts'],
  bundle: true,
  outdir: 'public/dist',
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  define: {
    PARTYKIT_HOST: JSON.stringify(host),
  },
});

console.log(`Built with PARTYKIT_HOST=${host}`);
