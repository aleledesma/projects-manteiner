/**
 * Derivacion del JSON Schema que se le pasa a opencode como `format.schema`.
 *
 * Zod 4 trae `z.toJSONSchema()` nativo, asi que no hace falta `zod-to-json-schema`
 * (el doc 06 lo mencionaba; quedo desactualizado).
 */

import { z } from "zod";

import { maintenanceReportSchema } from "./maintenance-report.ts";

export type JsonSchema = Record<string, unknown>;

export interface BuildOptions {
  /**
   * Version del dialecto. opencode reenvia el schema al proveedor, y no todos
   * aceptan draft-2020-12. Si la Fase 1 (I5) muestra que lo rechaza, se cambia
   * aca y en un solo lugar.
   */
  target?: "draft-2020-12" | "draft-07" | "openapi-3.0";
}

/**
 * JSON Schema del informe de mantenimiento.
 *
 * `z.toJSONSchema` emite `additionalProperties: false` por defecto, que es lo que
 * queremos: cuanto mas estricto, menos margen tiene el modelo para inventar campos.
 */
export function buildMaintenanceReportJsonSchema(options: BuildOptions = {}): JsonSchema {
  return z.toJSONSchema(maintenanceReportSchema, {
    target: options.target ?? "draft-2020-12",
  }) as JsonSchema;
}

/**
 * Variante "estricta": todas las propiedades pasan a ser requeridas, y las que
 * eran opcionales admiten `null`.
 *
 * Por que existe: el modo structured output estricto de algunos proveedores
 * (OpenAI entre ellos) exige que `required` liste TODAS las claves de cada
 * objeto. Un schema con opcionales se rechaza de plano.
 *
 * 🔴 Cual de las dos variantes usar es exactamente la pregunta I5. Hasta
 * medirlo, la normal es la que se usa por defecto; esta queda lista por si hace
 * falta. Ver docs/13-hallazgos-spike.md.
 */
export function buildStrictMaintenanceReportJsonSchema(options: BuildOptions = {}): JsonSchema {
  return makeAllPropertiesRequired(buildMaintenanceReportJsonSchema(options));
}

function makeAllPropertiesRequired(node: unknown): JsonSchema {
  if (Array.isArray(node)) {
    return node.map(makeAllPropertiesRequired) as unknown as JsonSchema;
  }
  if (node === null || typeof node !== "object") {
    return node as JsonSchema;
  }

  const copia: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(node as Record<string, unknown>)) {
    copia[clave] = makeAllPropertiesRequired(valor);
  }

  const propiedades = copia["properties"];
  if (copia["type"] === "object" && propiedades && typeof propiedades === "object") {
    const claves = Object.keys(propiedades as Record<string, unknown>);
    const requeridas = new Set((copia["required"] as string[] | undefined) ?? []);

    for (const clave of claves) {
      if (requeridas.has(clave)) continue;
      // Era opcional: se vuelve requerida pero nullable, para no cambiar la
      // semantica de "este campo puede no venir".
      const sub = (propiedades as Record<string, unknown>)[clave];
      (propiedades as Record<string, unknown>)[clave] = { anyOf: [sub, { type: "null" }] };
    }
    copia["required"] = claves;
  }

  return copia;
}

/** Tamaño del schema serializado. Util para diagnosticar limites del proveedor (I5). */
export function jsonSchemaSizeBytes(schema: JsonSchema): number {
  return Buffer.byteLength(JSON.stringify(schema), "utf8");
}
