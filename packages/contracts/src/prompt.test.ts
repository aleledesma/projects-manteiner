import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STEP_TITLES } from "./maintenance-report.ts";
import { AGENT_VERSION, buildMaintenancePrompt, maintenancePromptTemplate } from "./prompt.ts";

const ctx = {
  owner: "acme",
  repo: "api-gateway",
  branch: "main",
  sha: "a1b2c3d",
};

describe("buildMaintenancePrompt", () => {
  it("interpola el contexto del run", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /acme\/api-gateway/);
    assert.match(prompt, /main \(commit a1b2c3d\)/);
    assert.match(prompt, /\/work\/repo/);
  });

  it("no deja ningun placeholder sin resolver", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.equal(prompt.includes("{{"), false);
  });

  it("permite sobrescribir el workdir", () => {
    const prompt = buildMaintenancePrompt({ ...ctx, workdir: "/otro/lado" });
    assert.match(prompt, /\/otro\/lado/);
  });

  it("incluye los 7 titulos literales de la lista de tareas", () => {
    const prompt = buildMaintenancePrompt(ctx);
    for (const titulo of Object.values(STEP_TITLES)) {
      assert.ok(prompt.includes(titulo), `el prompt deberia pedir la tarea "${titulo}"`);
    }
  });

  it("deja explicito que el agente no crea el PR", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /NO intentes crear el PR/);
  });

  it("deja explicito que seguridad esta fuera de alcance", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /out_of_scope_notes/);
  });

  it("pide aplicar cambios compatibles y buscar versiones intermedias", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /politica por defecto es APLICAR patch y minor compatibles/);
    assert.match(prompt, /Si `latest` es un major, busca tambien la ultima version/);
    assert.match(prompt, /NUNCA apliques un major/);
    assert.match(prompt, /En versiones 0\.x no asumas/);
    assert.match(prompt, /No introduzcas prereleases en dependencias estables/);
  });

  it("no permite usar la falta de tests o CI como bloqueo del PR", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /falta de tests, cobertura, CI o credenciales de servicios externos NUNCA es/);
    assert.match(prompt, /Si no podes ejecutar ninguna verificacion, conserva los cambios compatibles/);
    assert.match(prompt, /La falta de tests se informa en el PR, no lo bloquea/);
  });

  it("distingue limitaciones del entorno de regresiones atribuibles a un candidato", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /Distingui los problemas preexistentes o del entorno/);
    assert.match(prompt, /Si aparece un fallo NUEVO atribuible a una actualizacion, revierte ese candidato/);
    assert.match(prompt, /difer[ií] SOLO ese candidato o grupo/);
    assert.match(prompt, /No fuerces[\s\S]*`--force` ni `--legacy-peer-deps`/);
  });

  it("mantiene lockfiles coherentes y publica solo cambios reales", () => {
    const prompt = buildMaintenancePrompt(ctx);
    assert.match(prompt, /--ignore-scripts/);
    assert.match(prompt, /Conserva manifiestos y lockfiles coherentes/);
    assert.match(prompt, /Si dejaste actualizaciones aplicadas, `proposed_pull_request` DEBE ser un objeto/);
    assert.match(prompt, /no inventes un diff ni un PR vacio/);
    assert.doesNotMatch(prompt, /Cualquier otro archivo esta denegado/);
  });
});

describe("version del prompt", () => {
  it("expone una version estable para congelar en runs.agent_version", () => {
    assert.equal(AGENT_VERSION, "maintenance@2");
  });

  it("la plantilla cruda conserva los placeholders", () => {
    assert.ok(maintenancePromptTemplate().includes("{{owner}}"));
  });
});
