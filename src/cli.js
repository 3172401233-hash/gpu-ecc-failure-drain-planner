#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { planDrain } from './drain-planner.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const filePath = process.argv[2];
  const raw = filePath ? await readFile(filePath, 'utf8') : await readStdin();
  if (!raw.trim()) {
    throw new Error('No input JSON provided (pass a file path or pipe JSON on stdin).');
  }
  const input = JSON.parse(raw);
  const plan = planDrain(input);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gpu-drain-plan: ${error.message}\n`);
  process.exitCode = 1;
});
