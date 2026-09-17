import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAgentDefinition,
  buildOpencodeConfig,
  readContext,
  runnerFiles,
  type RunnerContext,
} from "./workspace.ts";

const contexto: RunnerContext = {
  runId: "run-1",
  model: "openai/gpt-tools",
  prompt: "Sos un auditor de mantenimiento.\n\n## Alcance\nDependencias.\n",
  workdir: "/work/repo",
};

describe("config de opencode", () => {
  it("apaga snapshot, share y autoupdate", () => {
    const config = JSON.parse(buildOpencodeConfig(contexto)) as Record<string, unknown>;
    assert.equal(config["snapshot"], false);
    assert.equal(config["share"], "disabled");
    assert.equal(config["autoupdate"], false);
    assert.equal(config["model"], "openai/gpt-tools");
  });

  it("no emite claves de mas", () => {
    // Una clave que opencode no conozca puede hacer que rechace la config y el
    // contenedor no arranque: la lista se revisa a proposito.
    assert.deepEqual(Object.keys(JSON.parse(buildOpencodeConfig(contexto))).sort(), [
      "$schema",
      "autoupdate",
      "model",
      "share",
      "snapshot",
    ]);
  });
});

describe("definicion del agente", () => {
  it("deniega salir del workspace y habilita bash", () => {
    const definicion = buildAgentDefinition(contexto);
    assert.match(definicion, /^---\n/);
    assert.match(definicion, /external_directory: deny/);
    assert.match(definicion, /bash: allow/);
    assert.match(definicion, /temperature: 0\.1/);
  });

  it("incluye el prompt recibido, sin placeholders", () => {
    const definicion = buildAgentDefinition(contexto);
    assert.match(definicion, /Sos un auditor de mantenimiento\./);
    assert.doesNotMatch(definicion, /\{\{\w+\}\}/);
  });

  it("excluye .opencode del control de versiones antes de escribirlo", () => {
    const archivos = runnerFiles(contexto);
    assert.deepEqual(archivos.map((archivo) => archivo.path), [
      ".git/info/exclude",
      ".opencode/opencode.json",
      ".opencode/agents/maintainer.md",
    ]);
    // La exclusion se agrega, nunca reemplaza: el repo puede tener las suyas.
    const exclude = archivos[0]!;
    assert.equal(exclude.append, true);
    assert.match(exclude.content, /\.opencode\//);
    assert.equal(archivos[1]!.append, false);
  });
});

describe("contexto del entorno", () => {
  const base = {
    MANTEINER_RUN_ID: "run-1",
    MANTEINER_MODEL: "openai/gpt-tools",
    MANTEINER_PROMPT_B64: Buffer.from("Auditá esto.").toString("base64"),
  };

  it("decodifica el prompt y aplica el workdir por defecto", () => {
    const leido = readContext(base);
    assert.equal(leido.prompt, "Auditá esto.");
    assert.equal(leido.workdir, "/work/repo");
  });

  it("falla nombrando todo lo que falta", () => {
    assert.throws(
      () => readContext({ MANTEINER_RUN_ID: "run-1" }),
      /MANTEINER_MODEL, MANTEINER_PROMPT_B64/,
    );
  });

  it("rechaza un prompt vacio en vez de auditar sin instrucciones", () => {
    assert.throws(
      () => readContext({ ...base, MANTEINER_PROMPT_B64: Buffer.from("   ").toString("base64") }),
      /prompt vacio/,
    );
  });
});
