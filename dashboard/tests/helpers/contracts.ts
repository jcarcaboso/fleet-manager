import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Operator API response fixtures that the Server tests also check (`contracts/operator/*.json`, two levels above this file's
 * folder). Resolved from this file, not from the working directory, so the suite gives the same answer wherever `vitest` is started.
 * A missing directory is a failure, never a skip: a skipped contract test is a contract nobody checks.
 */
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/operator');

export const contract = <T = unknown>(name: string): T => {
  if (!existsSync(DIR)) throw new Error(`The contract fixtures are missing: ${DIR} does not exist. Run the tests from a full checkout of the repository.`);
  return JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as T;
};
