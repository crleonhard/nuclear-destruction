// Regenerates docs/api/openapi.json and docs/api/openapi.yaml from src/http/openapi.js.
//   npm run build:openapi
import { writeFileSync } from 'node:fs';
import { openapi } from '../src/http/openapi.js';
import { toYaml } from './to-yaml.js';

const json = `${JSON.stringify(openapi, null, 2)}\n`;
writeFileSync(new URL('../docs/api/openapi.json', import.meta.url), json);
writeFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), toYaml(JSON.parse(json)));
console.log('wrote docs/api/openapi.json and docs/api/openapi.yaml');
