import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactDeep, redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  it("redacta tokens de proveedores, GitHub, JWT y cabeceras", () => {
    const texto = [
      "openai sk-proj-abcdefghijklmnopqrstuvwx",
      "anthropic sk-ant-api03-abcdefghijklmnopqrst",
      "instalacion ghs_abcdefghijklmnopqrstuvwxyz0123",
      "pat github_pat_11ABCDEFG0123456789_abcdefghij",
      "jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJhLWZhbHNh",
      "Authorization: Bearer abc.def-ghi_jkl",
      "remote https://x-access-token:ghs_secreto@github.com/o/r.git",
    ].join("\n");

    const redactado = redactSecrets(texto);
    for (const secreto of ["sk-proj-", "sk-ant-", "ghs_abc", "github_pat_", "eyJhbGci", "abc.def-ghi", "ghs_secreto"]) {
      assert.ok(!redactado.includes(secreto), `quedo visible: ${secreto}`);
    }
    assert.match(redactado, /Bearer \[REDACTADO\]/);
    assert.match(redactado, /x-access-token:\[REDACTADO\]@github\.com/);
  });

  it("no toca texto comun", () => {
    const texto = "Actualiza zod de 3.22.4 a 3.23.8 en package.json (sk-1)";
    assert.equal(redactSecrets(texto), texto);
  });
});

describe("redactDeep", () => {
  it("recorre objetos y errores sin mutar el original", () => {
    const error = new Error("fallo con ghp_abcdefghijklmnopqrstuvwxyz0123");
    const original = { contexto: { token: "sk-abcdefghijklmnopqrstuv" }, err: error, n: 3 };
    const copia = redactDeep(original) as {
      contexto: { token: string };
      err: { message: string; stack: string; type: string };
      n: number;
    };

    assert.equal(copia.contexto.token, "[REDACTADO]");
    assert.equal(copia.err.type, "Error");
    assert.ok(!copia.err.message.includes("ghp_"));
    assert.ok(!copia.err.stack.includes("ghp_"));
    assert.equal(copia.n, 3);
    assert.equal(original.contexto.token, "sk-abcdefghijklmnopqrstuv");
  });
});
