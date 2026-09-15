# 00 — Visión y alcance

## El problema

Los repositorios acumulan deuda de mantenimiento en silencio: dependencias
desactualizadas, runtimes que llegan a end-of-life, patrones de código que se
degradan. Revisarlo manualmente es tedioso y se posterga.

## La propuesta

Una app donde el usuario:

1. Inicia sesión con GitHub.
2. Conecta un proveedor de IA (con sus propias credenciales) y elige el modelo.
3. Vincula uno o más repositorios.
4. Dispara una **auditoría de mantenimiento** sobre un repo.
5. Ve el progreso **en tiempo real**, y al terminar obtiene:
   - un **Pull Request** con actualizaciones de dependencias seguras,
   - un **JSON estructurado** con los pasos, hallazgos y recomendaciones,
   - un **reporte PDF** formal,
   - un **histórico** de todas las auditorías del repo.

El agente se ejecuta **siempre dentro de un contenedor efímero de Docker**, nunca
en el proceso del servidor.

## Objetivos (v1)

- 🟢 Login con GitHub (OAuth).
- 🟢 Conectar proveedor de IA y seleccionar modelo (catálogo provisto por opencode), tanto por
  **API key** como por **OAuth de suscripción** (ChatGPT Plus/Pro, vía device code).
- 🟢 Vincular repositorios vía GitHub App con permisos mínimos.
- 🟢 Ejecutar la auditoría de mantenimiento en un contenedor efímero.
- 🟢 Streaming de progreso por SSE + persistencia del histórico.
- 🟢 Creación del PR de dependencias seguras.
- 🟢 Salida JSON estructurada validada contra un JSON Schema.
- 🟢 Reporte PDF descargable.
- 🟢 SQLite como base de datos.

## No-objetivos (v1)

Explícitamente **fuera de alcance** por ahora, para no inflar la primera versión:

- ❌ Auditoría de **seguridad** (diseñada como segundo tipo de auditoría, se implementa en v2).
- ❌ Multi-tenant / organizaciones / equipos. Un usuario = sus repos.
- ❌ Ejecución programada (cron / auditorías periódicas automáticas).
- ❌ Proveedores OAuth **distintos de OpenAI** (Claude Pro/Max, Copilot, GitLab Duo, xAI…).
  v1 soporta API keys + **OpenAI por OAuth de suscripción**, que es el que hace falta para
  probar. Los demás requieren replicar el flujo de cada uno, o que opencode exponga su
  `authorize()` por HTTP. Ver [04](./04-proveedores-ia-opencode.md).
- ❌ Escalado horizontal / múltiples workers en máquinas distintas.
- ❌ El agente **no implementa features nuevas** ni refactors automáticos: solo
  actualiza dependencias seguras y **recomienda** el resto.

## Principios de diseño

1. **El token de GitHub y el LLM nunca coexisten en el mismo contenedor.** Clonar y publicar
   los hacen contenedores auxiliares de vida corta, sin LLM; el contenedor del agente monta
   el mismo workspace ya limpio de credenciales. No es una regla de configuración: es una
   imposibilidad estructural. Ver [05](./05-ejecucion-en-docker.md) y [10](./10-seguridad.md).

2. **El repositorio nunca vive en el filesystem de la aplicación.** Se clona en un volumen
   efímero de Docker que se destruye con el run. No es "se clona en la máquina y después se
   borra": el proceso de la API no tiene forma de leerlo, y su ciclo de vida es el del run.
3. **El agente propone, la app dispone.** El agente genera cambios en el workspace
   y un `proposed_pull_request`; la app decide si crea el PR y con qué contenido.
4. **Todo lo que el agente hace queda registrado.** El streaming no es solo UI: cada
   paso se persiste y forma el histórico.
5. **Salida estructurada y validada.** Nada de parsear prosa: JSON Schema sobre la
   capacidad de structured output de opencode.
6. **Todo efímero, sin estado, mínimo privilegio.** Contenedores y volumen se crean,
   corren y se destruyen. Lo único que sobrevive es lo que decidimos guardar: el informe,
   el PDF y el PR.

## Glosario

| Término | Significado |
|---------|-------------|
| **Run / Ejecución** | Una corrida del agente sobre un repositorio, con su ciclo de vida y su resultado. |
| **Auditoría de mantenimiento** | El tipo de run de v1: dependencias, runtime, salud general del código. |
| **Orquestador** | El componente del backend que prepara, lanza, supervisa y recolecta el contenedor. |
| **Runner** | El entrypoint que corre *dentro* del contenedor y expone el servidor de opencode. |
| **Workspace** | El directorio con el clon del repo que se monta en el contenedor. |
| **Finding / Hallazgo** | Una observación del agente con recomendación, severidad y referencias. |
| **Step / Paso** | Una fase del trabajo del agente, con título y descripción, que se muestra en el histórico. |
