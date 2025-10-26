import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidateRoots = [
  process.cwd(),
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../..'),
  path.resolve(__dirname, '../../..'),
];

function findProjectRoot(startDir) {
  let current = startDir;
  const { root } = path.parse(current);
  while (true) {
    const hasEnv = fs.existsSync(path.join(current, '.env')) || fs.existsSync(path.join(current, '.env.local'));
    if (hasEnv) {
      return current;
    }
    if (current === root) {
      return null;
    }
    current = path.dirname(current);
  }
}

const projectRoot = candidateRoots.reduce((acc, dir) => acc || findProjectRoot(dir), null) || process.cwd();

const envSequence = [
  { path: path.join(projectRoot, '.env'), options: { override: false } },
  { path: path.join(projectRoot, '.env.local'), options: { override: true } },
];

envSequence.forEach(({ path: envPath, options }) => {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, ...options });
  }
});
