import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validReport } from "./fixtures.ts";
import { maintenanceReportSchema, STEP_KEYS } from "./maintenance-report.ts";

describe("maintenanceReportSchema", () => {
  it("acepta un informe completo valido", () => {
    const result = maintenanceReportSchema.safeParse(validReport());
    assert.ok(result.success, JSON.stringify(result.error?.issues, null, 2));
  });

  it("acepta un informe sin PR (repositorio sin cambios)", () => {
    const report = validReport({
      proposed_pull_request: null,
      dependency_updates: { applied: [], deferred: [], unmaintained: [] },
    });
    assert.ok(maintenanceReportSchema.safeParse(report).success);
  });

  it("rechaza un schema_version distinto", () => {
    const report = { ...validReport(), schema_version: "2.0" };
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  it("rechaza un audit_type que no sea maintenance", () => {
    const report = { ...validReport(), audit_type: "security" };
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  it("rechaza health_score fuera de 0..100", () => {
    for (const valor of [-1, 101, 50.5]) {
      const report = validReport();
      report.summary.health_score = valor;
      assert.equal(
        maintenanceReportSchema.safeParse(report).success,
        false,
        `health_score ${valor} deberia ser invalido`,
      );
    }
  });

  it("descarta propiedades desconocidas en vez de rechazar el informe", () => {
    // Decision deliberada: si el modelo agrega un campo de mas, no tiramos una
    // auditoria de 20 minutos por eso. El `additionalProperties: false` del JSON
    // Schema ya le pide al modelo que no lo haga; aca simplemente lo limpiamos.
    const report = { ...validReport(), campo_inventado: true };
    const result = maintenanceReportSchema.safeParse(report);

    assert.ok(result.success);
    assert.equal("campo_inventado" in result.data, false, "el campo extra se descarta");
  });

  it("rechaza un step con key fuera de las 7 fases", () => {
    const report = validReport();
    report.steps[0]!.key = "fase-inventada" as never;
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  it("acepta las 7 keys de fase", () => {
    for (const key of STEP_KEYS) {
      const report = validReport();
      report.steps = [{ key, title: "x", status: "completed", description: "y" }];
      assert.ok(maintenanceReportSchema.safeParse(report).success, `${key} deberia ser valida`);
    }
  });

  describe("finding_key", () => {
    const validos = ["runtime-eol", "runtime-eol:node:18", "dependency:next", "ci-cd:actions:v3"];
    const invalidos = ["Runtime-EOL", "runtime eol", "runtime_eol", "", "-runtime", "runtime--eol"];

    for (const key of validos) {
      it(`acepta "${key}"`, () => {
        const report = validReport();
        report.findings[0]!.finding_key = key;
        assert.ok(maintenanceReportSchema.safeParse(report).success);
      });
    }

    for (const key of invalidos) {
      it(`rechaza "${key}"`, () => {
        const report = validReport();
        report.findings[0]!.finding_key = key;
        assert.equal(maintenanceReportSchema.safeParse(report).success, false);
      });
    }
  });

  it("rechaza un bump major en las actualizaciones aplicadas", () => {
    const report = validReport();
    report.dependency_updates.applied[0]!.bump = "major" as never;
    assert.equal(
      maintenanceReportSchema.safeParse(report).success,
      false,
      "un major nunca puede figurar como aplicado",
    );
  });

  it("rechaza un headline mas largo que 160 caracteres", () => {
    const report = validReport();
    report.summary.headline = "x".repeat(161);
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  it("rechaza un titulo de PR mas largo que 100 caracteres", () => {
    const report = validReport();
    report.proposed_pull_request!.title = "x".repeat(101);
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });
});
