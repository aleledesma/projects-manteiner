# Manteiner — Documentación de planificación

Manteiner es una app de gestión de proyectos que conecta repositorios de GitHub y
ejecuta **agentes de IA de mantenimiento** sobre ellos dentro de contenedores
efímeros de Docker. El agente audita el repo, abre un PR con actualizaciones
seguras, devuelve un JSON estructurado con lo que hizo y genera un reporte PDF.

> Estado: **implementación**. Las Fases 0 y 1 están cerradas: API base,
> contratos, persistencia SQLite y cifrado de credenciales están implementados.

## Índice

| # | Documento | Qué responde |
|---|-----------|--------------|
| 00 | [Visión y alcance](./00-vision.md) | Qué construimos, qué NO, glosario |
| 01 | [Arquitectura](./01-arquitectura.md) | Componentes, stack, flujo de una ejecución |
| 02 | [Modelo de datos](./02-modelo-de-datos.md) | Esquema SQLite completo (DDL) |
| 03 | [Autenticación y GitHub](./03-autenticacion-github.md) | Login OAuth + GitHub App + permisos |
| 04 | [Proveedores de IA y opencode](./04-proveedores-ia-opencode.md) | SDK, credenciales, modelos, flujo de auth |
| 05 | [Ejecución en Docker](./05-ejecucion-en-docker.md) | Contenedor efímero, aislamiento, ciclo de vida |
| 06 | [Agente de mantenimiento](./06-agente-mantenimiento.md) | Comportamiento, fases, prompt, contrato JSON |
| 07 | [Progreso en tiempo real (SSE)](./07-progreso-sse.md) | Eventos, persistencia, reconexión |
| 08 | [Reportes PDF](./08-reportes-pdf.md) | Generación del informe formal |
| 09 | [API y UI](./09-api-y-ui.md) | Endpoints y pantallas |
| 10 | [Seguridad](./10-seguridad.md) | Modelo de amenazas y mitigaciones |
| 11 | [Roadmap](./11-roadmap.md) | Fases incrementales de implementación |
| 12 | [Decisiones abiertas](./12-decisiones-abiertas.md) | Lo decidido y lo que falta decidir |
| 13 | [Hallazgos de la Fase 0](./13-hallazgos-spike.md) | Qué confirmaron o refutaron los spikes |
| **14** | **[Estado actual (handoff)](./14-estado-actual.md)** | **Empezá por acá para retomar el trabajo** |

## Cómo leer esto

1. Empezá por **00** y **01** para el panorama general.
2. **12** lista lo que todavía hay que decidir o verificar: revisalo antes de
   implementar cualquier parte.
3. **11** define el orden de construcción paso a paso.

## Convenciones de estos documentos

- 🟢 **Decidido** — se implementa así, salvo que cambiemos de opinión explícitamente.
- 🟡 **Propuesto** — recomendación con fundamento, falta confirmación del usuario.
- 🔴 **A investigar** — requiere verificación técnica antes de implementar.

## Historial de revisiones

Las revisiones quedan registradas en [12](./12-decisiones-abiertas.md) con el planteo original,
la objeción y la resolución. No se borra lo que se descartó: saber por qué **no** se hizo algo
vale tanto como saber qué se hizo.

| Rev | Cambio |
|-----|--------|
| R1 | El workspace ya no se clona en el host. Tres contenedores secuenciales sobre un volumen efímero de Docker. Afecta [01](./01-arquitectura.md), [03](./03-autenticacion-github.md), [05](./05-ejecucion-en-docker.md), [10](./10-seguridad.md). |
| R1b | El volumen pasa de tmpfs (RAM) a disco virtual de Docker por defecto, con chequeo previo de tamaño del repo. `tmpfs` queda como opt-in. Afecta [05](./05-ejecucion-en-docker.md), [10](./10-seguridad.md). |
| R2 | OAuth de proveedores entra en v1: OpenAI con cuenta ChatGPT Plus por device code, sin contenedor de autenticación. Afecta [00](./00-vision.md), [04](./04-proveedores-ia-opencode.md), [09](./09-api-y-ui.md). |
| R3 | Spike 1: el access token de OpenAI dura 10 días y el refresh **rota**. Se invierte la estrategia de refresco y se elimina la relectura de credencial del contenedor. Afecta [02](./02-modelo-de-datos.md), [04](./04-proveedores-ia-opencode.md). |
| R4 | Spike 2: catálogo real de eventos (32 tipos) y `todo.updated` reemplaza el parseo de marcadores de texto. Afecta [06](./06-agente-mantenimiento.md), [07](./07-progreso-sse.md). |
| R5 | Fase 0 cerrada. Spike 3 salteado (sus preguntas pasan a criterios de aceptación de las fases 3 y 5) y `packages/contracts` se adelanta a la Fase 1 para cerrar I5 temprano. Afecta [11](./11-roadmap.md), [12](./12-decisiones-abiertas.md), [13](./13-hallazgos-spike.md). |
| R6 | Paso 1.3: I5, I4 e I12 cerrados contra opencode real. El campo es `info.structured` (no `structured_output`) y el runtime emite eventos fuera de la unión de tipos del SDK. Afecta [04](./04-proveedores-ia-opencode.md), [07](./07-progreso-sse.md), [13](./13-hallazgos-spike.md). |
