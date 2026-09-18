import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { openDatabase, type DatabaseConnection } from "../db/client.ts";
import { RunEventBus, type StoredEvent } from "./run-events.ts";

const directorios: string[] = [];
const abiertas: DatabaseConnection[] = [];
afterEach(() => {
  abiertas.splice(0).forEach((db) => db.close());
  directorios.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function base(): DatabaseConnection {
  const directorio = mkdtempSync(join(tmpdir(), "manteiner-eventos-"));
  directorios.push(directorio);
  const db = openDatabase(join(directorio, "t.db"));
  abiertas.push(db);
  db.sqlite.prepare(
    `INSERT INTO users (id, github_id, github_login, email_verified, created_at, updated_at)
     VALUES ('u1', 1, 'one', 0, 1, 1)`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, repository_selection, created_at, updated_at)
     VALUES ('i1', 1, 'one', 'User', 'all', 1, 1)`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO repositories
      (id, user_id, installation_id, github_repo_id, owner, name, full_name, default_branch,
       private, html_url, linked_at)
     VALUES ('r1','u1','i1',1,'one','r','one/r','main',0,'https://x',1)`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO runs
      (id, user_id, repository_id, audit_type, status, provider_id, model_id, agent_version,
       schema_version, queued_at)
     VALUES ('run-1','u1','r1','maintenance','running','openai','m','maintenance@1','1.0.0',1)`,
  ).run();
  return db;
}

describe("RunEventBus", () => {
  it("persiste antes de emitir, con ids monotonos", () => {
    const db = base();
    const bus = new RunEventBus(db, () => 1_000);
    const recibidos: StoredEvent[] = [];
    bus.subscribe("run-1", (evento) => {
      // Al llegar acá el evento ya tiene que estar en la base: si no, un cliente
      // podría pedir replay de un id que todavía no existe.
      const fila = db.sqlite.prepare("SELECT id FROM run_events WHERE id = ?").get(evento.id);
      assert.ok(fila, "el evento se emitió antes de persistirse");
      recibidos.push(evento);
    });

    bus.publish("run-1", { type: "run.status", payload: { status: "running", at: 1 } });
    bus.publish("run-1", { type: "agent.tool", payload: { callId: "c", name: "read", title: "t", status: "running" } });

    assert.deepEqual(recibidos.map((e) => e.type), ["run.status", "agent.tool"]);
    assert.ok(recibidos[1]!.id > recibidos[0]!.id, "los ids tienen que crecer");
  });

  it("replay devuelve solo lo posterior al cursor", () => {
    const db = base();
    const bus = new RunEventBus(db);
    const primero = bus.publish("run-1", { type: "run.status", payload: { status: "running", at: 1 } });
    bus.publish("run-1", { type: "agent.file_edited", payload: { path: "package.json" } });

    const posteriores = bus.replay("run-1", primero.id);
    assert.deepEqual(posteriores.map((e) => e.type), ["agent.file_edited"]);
    assert.deepEqual(bus.replay("run-1", 0).length, 2);
  });

  it("desuscribirse corta la entrega", () => {
    const db = base();
    const bus = new RunEventBus(db);
    let recibidos = 0;
    const cortar = bus.subscribe("run-1", () => (recibidos += 1));
    bus.publish("run-1", { type: "agent.file_edited", payload: { path: "a" } });
    cortar();
    bus.publish("run-1", { type: "agent.file_edited", payload: { path: "b" } });
    assert.equal(recibidos, 1);
  });

  it("un suscriptor que lanza no frena a los demas ni al run", () => {
    const db = base();
    const bus = new RunEventBus(db);
    let sano = 0;
    bus.subscribe("run-1", () => { throw new Error("roto") });
    bus.subscribe("run-1", () => (sano += 1));
    assert.doesNotThrow(() => bus.publish("run-1", { type: "agent.file_edited", payload: { path: "a" } }));
    assert.equal(sano, 1);
  });

  it("trunca un payload enorme en vez de guardarlo entero", () => {
    const db = base();
    const bus = new RunEventBus(db);
    const evento = bus.publish("run-1", { type: "agent.message", payload: { text: "x".repeat(50_000) } });
    const payload = evento.payload as { text: string; truncated?: boolean };
    assert.equal(payload.truncated, true);
    assert.ok(payload.text.length < 9_000, "el payload sigue siendo enorme");
    assert.ok(payload.text.endsWith("…"));
  });
});
