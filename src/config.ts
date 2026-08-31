/**
 * Environment loading. Node reads .env natively (process.loadEnvFile), so there is no
 * dotenv dependency.
 *
 * .env is gitignored and holds local secrets. .env.example documents the shape.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;

/** Idempotent. Values already present in the real environment always win. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Read a required variable, failing loudly rather than proceeding half-configured. */
export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  loadEnv();
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}
