// Port Vela — entrypoint for the make.fun gta6-01 bounty.
//
// Copies the built game and its screenshots into the output directory,
// then writes the dossier the bounty scorer reads. Run with Node 22 and
// only the standard library; no dependencies to install.
//
//   MAKEFUN_OUTPUT_DIR=/some/dir node main.ts
//
// With no environment variable the output goes to /output.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The caps the gta6-01 bounty sets for the dossier.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  mkdirSync(outDir, { recursive: true });

  const gameDir = join(here, 'game');
  cpSync(gameDir, join(outDir, 'game'), { recursive: true });

  const shotsDir = join(here, 'screenshots');
  if (existsSync(shotsDir)) {
    cpSync(shotsDir, join(outDir, 'screenshots'), { recursive: true });
  }

  const dossier = buildDossier(outDir, CAPS);
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  console.log(`wrote dossier.json to ${outDir}`);
}

main();
