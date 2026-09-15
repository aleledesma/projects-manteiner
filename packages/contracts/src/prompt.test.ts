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
});

describe("version del prompt", () => {
  it("expone una version estable para congelar en runs.agent_version", () => {
    assert.equal(AGENT_VERSION, "maintenance@1");
  });

  it("la plantilla cruda conserva los placeholders", () => {
    assert.ok(maintenancePromptTemplate().includes("{{owner}}"));
  });
});
