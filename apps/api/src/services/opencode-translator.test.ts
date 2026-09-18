import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpencodeTranslator, claveDePaso } from "./opencode-translator.ts";
import type { RunEvent } from "./run-events.ts";

function traductor(): { t: OpencodeTranslator; emitidos: RunEvent[] } {
  const emitidos: RunEvent[] = [];
  return { t: new OpencodeTranslator((evento) => emitidos.push(evento)), emitidos };
}

describe("OpencodeTranslator", () => {
  it("ignora los tipos que no nos interesan sin romperse", () => {
    const { t, emitidos } = traductor();
    // `plugin.added` fue 45 de 79 eventos en la corrida de prueba y ni siquiera
    // existe en la union de tipos del SDK: el default tiene que tolerarlo.
    for (const type of ["plugin.added", "lsp.updated", "tui.toast.show", "catalog.updated"]) {
      t.handle({ type, properties: {} });
    }
    t.handle(undefined);
    t.handle({ type: 42 });
    assert.deepEqual(emitidos, []);
  });

  it("traduce los todos a pasos, relacionandolos por texto normalizado", () => {
    const { t, emitidos } = traductor();
    t.handle({
      type: "todo.updated",
      properties: {
        todos: [
          // Con tilde: el modelo escribe en espanol correcto y el titulo
          // canonico del contrato es ASCII.
          { content: "Investigación de dependencias", status: "in_progress" },
          { content: "Reconocimiento del repositorio", status: "completed" },
          { content: "Algo que no es una fase", status: "pending" },
        ],
      },
    });

    assert.equal(emitidos.length, 1);
    const evento = emitidos[0]!;
    assert.equal(evento.type, "steps.updated");
    const steps = (evento.payload as { steps: { key: string; status: string }[] }).steps;
    assert.deepEqual(steps.map((paso) => paso.key), [
      "dependency-research",
      "repo-discovery",
      "unknown-2",
    ]);
    assert.deepEqual(steps.map((paso) => paso.status), ["running", "completed", "pending"]);
  });

  it("emite el retry, que es lo que distingue un cuelgue de una espera", () => {
    const { t, emitidos } = traductor();
    t.handle({ type: "session.status", properties: { status: { type: "busy" } } });
    assert.equal(emitidos.length, 0, "busy no es noticia");

    t.handle({
      type: "session.status",
      properties: { status: { type: "retry", attempt: 2, message: "rate limit", next: 9_000 } },
    });
    assert.equal(emitidos[0]?.type, "agent.retrying");
    assert.deepEqual(emitidos[0]?.payload, { attempt: 2, message: "rate limit", nextAt: 9_000 });
  });

  it("usa el title de la herramienta, que ya viene listo para mostrar", () => {
    const { t, emitidos } = traductor();
    t.handle({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "c1",
          tool: "read",
          state: { status: "running", title: "Reading package.json" },
        },
      },
    });
    assert.deepEqual(emitidos[0], {
      type: "agent.tool",
      payload: { callId: "c1", name: "read", title: "Reading package.json", status: "running" },
    });
  });

  it("no emite el razonamiento: es ruido y puede ser enorme", () => {
    const { t, emitidos } = traductor();
    t.handle({
      type: "message.part.updated",
      properties: { part: { type: "reasoning", text: "x".repeat(50_000) } },
    });
    assert.deepEqual(emitidos, []);
  });

  it("acumula deltas de texto y los emite juntos al superar el tope", () => {
    const { t, emitidos } = traductor();
    // Por debajo del tope no emite: si no, un delta por caracter satura todo.
    t.handle({ type: "message.part.delta", properties: { part: { type: "text" }, delta: "hola " } });
    assert.equal(emitidos.length, 0, "un delta suelto no se emite");

    t.handle({
      type: "message.part.delta",
      properties: { part: { type: "text" }, delta: "x".repeat(400) },
    });
    assert.equal(emitidos.length, 1);
    assert.match((emitidos[0]!.payload as { text: string }).text, /^hola x+$/);
  });

  it("vacia el buffer pendiente al cerrar la sesion", () => {
    const { t, emitidos } = traductor();
    t.handle({ type: "message.part.updated", properties: { part: { type: "text", text: "corto" } } });
    assert.equal(emitidos.length, 0);
    t.flush();
    assert.deepEqual(emitidos[0]?.payload, { text: "corto" });
  });
});

describe("claveDePaso", () => {
  it("resuelve con tildes, mayusculas y puntuacion distinta", () => {
    assert.equal(claveDePaso("Análisis de runtime y entorno"), "runtime-analysis");
    assert.equal(claveDePaso("REVISIÓN DE MANTENIBILIDAD"), "maintainability-review");
    assert.equal(claveDePaso("Elaboración del informe."), "report-assembly");
  });

  it("devuelve undefined si no se parece a ninguna fase", () => {
    assert.equal(claveDePaso("Comprar leche"), undefined);
  });
});
