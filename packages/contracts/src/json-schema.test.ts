import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMaintenanceReportJsonSchema,
  buildStrictMaintenanceReportJsonSchema,
  jsonSchemaSizeBytes,
} from "./json-schema.ts";

describe("buildMaintenanceReportJsonSchema", () => {
  const schema = buildMaintenanceReportJsonSchema();

  it("produce un objeto con las secciones del informe", () => {
    assert.equal(schema["type"], "object");
    const props = schema["properties"] as Record<string, unknown>;
    for (const clave of [
      "schema_version",
      "audit_type",
      "summary",
      "stack_detected",
      "steps",
      "dependency_updates",
      "findings",
      "proposed_pull_request",
      "out_of_scope_notes",
      "limitations",
    ]) {
      assert.ok(props[clave], `falta la propiedad ${clave}`);
    }
  });

  it("cierra el objeto a propiedades desconocidas", () => {
    assert.equal(schema["additionalProperties"], false);
  });

  it("es serializable a JSON", () => {
    assert.doesNotThrow(() => JSON.stringify(schema));
  });

  it("acepta otros dialectos", () => {
    assert.doesNotThrow(() => buildMaintenanceReportJsonSchema({ target: "draft-07" }));
  });

  it("reporta su tamaño, para diagnosticar limites del proveedor (I5)", () => {
    const bytes = jsonSchemaSizeBytes(schema);
    assert.ok(bytes > 0);
    // Sin umbral duro: no sabemos el limite real hasta medirlo contra opencode.
    // El test existe para que el numero quede visible en la salida.
    console.log(`    JSON Schema: ${bytes} bytes`);
  });
});

describe("buildStrictMaintenanceReportJsonSchema", () => {
  it("marca como requeridas todas las propiedades del objeto raiz", () => {
    const strict = buildStrictMaintenanceReportJsonSchema();
    const props = Object.keys(strict["properties"] as Record<string, unknown>);
    const required = strict["required"] as string[];
    assert.deepEqual([...required].sort(), [...props].sort());
  });

  it("vuelve nullable lo que antes era opcional", () => {
    const strict = buildStrictMaintenanceReportJsonSchema();
    const steps = (strict["properties"] as Record<string, any>)["steps"];
    const step = steps["items"];
    // `skip_reason` era opcional en el schema normal.
    const skipReason = step["properties"]["skip_reason"];
    assert.ok(skipReason["anyOf"], "skip_reason deberia haberse vuelto anyOf con null");
    assert.ok(
      (step["required"] as string[]).includes("skip_reason"),
      "skip_reason deberia figurar como requerida en modo estricto",
    );
  });
});
