# Spikes — Fase 0

Scripts **descartables** de verificación técnica. No forman parte de la aplicación y no se
van a mantener: existen para responder las preguntas abiertas de
[`docs/12-decisiones-abiertas.md`](../docs/12-decisiones-abiertas.md) antes de escribir código
de producción.

Los hallazgos se anotan en `docs/13-hallazgos-spike.md` a medida que salen.

## Instalación

```bash
cd spikes
npm install
```

## Spike 1 — Device flow de OpenAI

```bash
npm run device-flow          # flujo completo + prueba de refresh
npm run device-flow:refresh  # solo refresca los tokens ya guardados
```

Obtiene credenciales OAuth de una cuenta ChatGPT Plus/Pro sin navegador en el servidor y sin
callback en localhost. Responde:

1. ¿Funciona el device flow con esta cuenta?
2. ¿De dónde sale el `accountId` en los claims del JWT?
3. ¿Cuánto dura el access token?
4. **¿Rota el refresh token al usarlo?** — define si hay que releer la credencial del
   contenedor antes de destruirlo, o si alcanza con refrescar desde el host.

Guarda el resultado en `.out/openai-tokens.json` (gitignored), con la forma exacta que espera
`client.auth.set()` de opencode. El spike 2 lo consume desde ahí.

⚠️ Ese archivo contiene credenciales reales de tu cuenta de OpenAI. No lo compartas ni lo
subas a ningún lado.

ℹ️ El `client_id` y los endpoints son los del CLI de Codex, públicos en el repositorio de
opencode. Usar la suscripción a través de un cliente de terceros está sujeto a los términos de
OpenAI: vale tenerlo presente si algún día la app se expone a otros usuarios.
