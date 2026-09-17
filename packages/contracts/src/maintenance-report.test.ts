import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validReport } from "./fixtures.ts";
import { maintenanceReportSchema } from "./maintenance-report.ts";

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

  it("exige exactamente las 7 fases", () => {
    const report = validReport();
    report.steps.pop();
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  // El orden y el titulo NO son del schema: `z.toJSONSchema()` no puede
  // representar un refine, asi que el modelo recibe `title` como string libre.
  // Rechazarlo por eso seria castigarlo por una regla que nunca se le dio; lo
  // canonico lo restaura `normalizeReport`.
  it("acepta las fases en otro orden y con otros titulos", () => {
    const report = validReport();
    [report.steps[0], report.steps[1]] = [report.steps[1]!, report.steps[0]!];
    report.steps[0]!.title = "Inventario de dependencias";
    assert.equal(maintenanceReportSchema.safeParse(report).success, true);
  });

  it("rechaza que falte una fase o que una venga repetida", () => {
    const report = validReport();
    report.steps[1]!.key = report.steps[0]!.key;
    assert.equal(maintenanceReportSchema.safeParse(report).success, false);
  });

  it("acepta null en opcionales requeridos por structured output estricto", () => {
    const report = validReport();
    for (const step of report.steps) {
      step.evidence = null;
      step.skip_reason = null;
    }
    report.stack_detected[0]!.version = null;
    report.stack_detected[0]!.evidence = null;
    report.findings[0]!.effort = null;
    report.findings[0]!.locations![0]!.note = null;
    report.findings[0]!.references![0]!.official = null;

    const result = maintenanceReportSchema.safeParse(report);
    assert.ok(result.success, JSON.stringify(result.error?.issues, null, 2));
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
