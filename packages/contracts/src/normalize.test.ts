import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validReport } from "./fixtures.ts";
import { normalizeReport } from "./normalize.ts";

function codigos(warnings: { code: string }[]): string[] {
  return warnings.map((w) => w.code);
}

describe("normalizeReport", () => {
  it("no toca un informe ya coherente", () => {
    const { report, warnings } = normalizeReport(validReport());
    assert.deepEqual(warnings, []);
    assert.deepEqual(report, validReport());
  });

  it("no muta el informe original", () => {
    const original = validReport();
    original.findings[0]!.severity = "high";
    original.findings[0]!.confidence = "low";

    const { report } = normalizeReport(original);

    assert.equal(report.findings[0]!.severity, "medium", "la copia se normaliza");
    assert.equal(original.findings[0]!.severity, "high", "el original queda intacto");
  });

  describe("finding_key duplicados", () => {
    it("los desambigua en vez de descartar el hallazgo", () => {
      const original = validReport();
      original.findings = [
        { ...original.findings[0]!, finding_key: "dependency:zod" },
        { ...original.findings[0]!, finding_key: "dependency:zod" },
        { ...original.findings[0]!, finding_key: "dependency:zod" },
      ];

      const { report, warnings } = normalizeReport(original);

      assert.equal(report.findings.length, 3, "no se pierde ningun hallazgo");
      assert.deepEqual(
        report.findings.map((f) => f.finding_key),
        ["dependency:zod", "dependency:zod-2", "dependency:zod-3"],
      );
      assert.deepEqual(codigos(warnings), ["DUPLICATE_FINDING_KEY", "DUPLICATE_FINDING_KEY"]);
    });
  });

  describe("referencias inseguras", () => {
    it("descarta las que no son https", () => {
      const original = validReport();
      original.findings[0]!.references = [
        { title: "ok", url: "https://ejemplo.com/a" },
        { title: "insegura", url: "http://ejemplo.com/b" },
        { title: "rara", url: "javascript:alert(1)" },
        { title: "rota", url: "no-es-una-url" },
      ];

      const { report, warnings } = normalizeReport(original);

      assert.equal(report.findings[0]!.references!.length, 1);
      assert.equal(report.findings[0]!.references![0]!.url, "https://ejemplo.com/a");
      assert.deepEqual(codigos(warnings), ["INSECURE_REFERENCE_DROPPED"]);
    });

    it("descarta changelogs y guias de migracion que no son https", () => {
      const original = validReport();
      original.dependency_updates.applied[0]!.changelog_url = "";
      original.dependency_updates.deferred[0]!.migration_guide_url = "javascript:alert(1)";

      const { report, warnings } = normalizeReport(original);

      assert.equal(report.dependency_updates.applied[0]!.changelog_url, undefined);
      assert.equal(report.dependency_updates.deferred[0]!.migration_guide_url, undefined);
      assert.deepEqual(codigos(warnings), [
        "INSECURE_CHANGELOG_URL_DROPPED",
        "INSECURE_MIGRATION_URL_DROPPED",
      ]);
    });
  });

  describe("severidad sin sustento", () => {
    it("degrada high + confidence low a medium", () => {
      const original = validReport();
      original.findings[0]!.severity = "high";
      original.findings[0]!.confidence = "low";

      const { report, warnings } = normalizeReport(original);

      assert.equal(report.findings[0]!.severity, "medium");
      assert.deepEqual(codigos(warnings), ["SEVERITY_DOWNGRADED"]);
    });

    it("no toca high con confidence high", () => {
      const { report, warnings } = normalizeReport(validReport());
      assert.equal(report.findings[0]!.severity, "high");
      assert.deepEqual(warnings, []);
    });
  });

  describe("coherencia entre pasos y PR", () => {
    it("avisa si un paso esta skipped sin motivo", () => {
      const original = validReport();
      original.steps[0]!.status = "skipped";

      const { warnings } = normalizeReport(original);
      assert.ok(codigos(warnings).includes("MISSING_SKIP_REASON"));
    });

    it("no avisa si el paso skipped explica por que", () => {
      const original = validReport();
      original.steps[0]!.status = "skipped";
      original.steps[0]!.skip_reason = "No se reconocio ningun gestor de paquetes.";

      const { warnings } = normalizeReport(original);
      assert.ok(!codigos(warnings).includes("MISSING_SKIP_REASON"));
    });

    it("avisa si declara actualizaciones aplicadas pero no propone PR", () => {
      const original = validReport({ proposed_pull_request: null });
      const { warnings } = normalizeReport(original);
      assert.ok(codigos(warnings).includes("APPLIED_WITHOUT_PR"));
    });

    it("avisa si propone PR sin ninguna actualizacion aplicada", () => {
      const original = validReport();
      original.dependency_updates.applied = [];

      const { warnings } = normalizeReport(original);
      assert.ok(codigos(warnings).includes("PR_WITHOUT_APPLIED"));
    });
  });
});
