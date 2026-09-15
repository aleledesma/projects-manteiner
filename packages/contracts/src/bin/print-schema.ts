/**
 * Imprime el JSON Schema del informe, para inspeccionarlo a ojo o guardarlo.
 *
 *   npm run print-schema --workspace @manteiner/contracts
 *   npm run print-schema --workspace @manteiner/contracts -- --strict > schema.json
 */

import {
  buildMaintenanceReportJsonSchema,
  buildStrictMaintenanceReportJsonSchema,
  jsonSchemaSizeBytes,
} from "../json-schema.ts";

const strict = process.argv.includes("--strict");
const schema = strict
  ? buildStrictMaintenanceReportJsonSchema()
  : buildMaintenanceReportJsonSchema();

process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
process.stderr.write(
  `\n${strict ? "estricto" : "normal"}: ${jsonSchemaSizeBytes(schema)} bytes\n`,
);
