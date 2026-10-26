import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The Operator API response fixtures that the Server tests also check (`contracts/operator/*.json`, one level above `dashboard/`). */
const DIR = resolve(process.cwd(), '../contracts/operator');
export const contractsAvailable = existsSync(DIR);
export const contract = <T = unknown>(name: string): T => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as T;
