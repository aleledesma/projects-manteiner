# 06 — Agente de auditoría de mantenimiento

Este documento es el **contrato de comportamiento** del agente: qué hace, qué no hace, y
exactamente qué devuelve.

## Misión

> Auditar el estado de mantenimiento de un repositorio y producir: (a) un PR con las
> actualizaciones de dependencias que son seguras de aplicar, (b) un informe estructurado
> con hallazgos accionables y referencias verificables.

## Alcance — qué SÍ y qué NO

| ✅ Sí | ❌ No |
|-------|-------|
| Actualizar dependencias sin breaking changes | Aplicar majors con breaking changes |
| Detectar runtimes/servicios cerca de EOL | Reportar vulnerabilidades (eso es la auditoría de seguridad) |
| Recomendar refactors de mantenibilidad | Implementar esos refactors |
| Señalar código duplicado, tooling desactualizado, CI obsoleto | Proponer funcionalidades nuevas |
| Opinar sobre el estado general del repo | Cambiar decisiones de arquitectura |
| Dar referencias oficiales con URL | Inventar referencias o versiones |

🟢 La separación mantenimiento / seguridad es estricta. Si el agente encuentra algo que
parece una vulnerabilidad, lo **anota como nota fuera de alcance** y sigue: no lo convierte
en un hallazgo de mantenimiento. Mezclar los dos tipos hace que el informe deje de ser
comparable entre runs y confunde la priorización del usuario.

## Fases del trabajo

El agente recorre fases fijas. Cada una es un **step** que se emite en vivo y aparece en el
histórico. El orden es deliberado: descubrir antes de juzgar, juzgar antes de modificar.

| # | `key` | Título | Qué hace |
|---|-------|--------|----------|
| 1 | `repo-discovery` | Reconocimiento del repositorio | Detecta lenguajes, gestor de paquetes, frameworks, estructura, scripts, CI. |
| 2 | `dependency-inventory` | Inventario de dependencias | Lee manifiestos y lockfiles. Arma la lista con versión actual vs. última. |
| 3 | `dependency-research` | Investigación de dependencias | Para cada candidata a actualizar: changelog, breaking changes, estado de mantenimiento del paquete. |
| 4 | `safe-updates` | Aplicación de actualizaciones seguras | Modifica manifiestos y lockfiles **solo** con patch/minor sin breaking changes. |
| 5 | `runtime-analysis` | Análisis de runtime y entorno | Versión de Node/Python/Go, imágenes Docker, runtimes de AWS Lambda, versiones de CI. Busca EOL y fechas de fin de soporte. |
| 6 | `maintainability-review` | Revisión de mantenibilidad | Duplicación, componentes que piden reutilización, tooling ausente o viejo, configuración inconsistente. |
| 7 | `report-assembly` | Elaboración del informe | Consolida hallazgos, asigna severidad y esfuerzo, arma el resumen y el cuerpo del PR. |

🟢 Un paso puede terminar en `skipped` con motivo (ej.: `dependency-inventory` en un repo sin
gestor de paquetes reconocido). Saltear ≠ fallar.

🟢 **Las 7 fases se materializan como la lista de tareas nativa de opencode.** El prompt le pide
al agente crearlas al inicio con texto literal, y cada cambio dispara un evento `todo.updated`
que mueve la UI en vivo. Es lo que reemplazó al parseo de marcadores de texto que proponía la
primera versión del diseño — ver [07](./07-progreso-sse.md) y [13](./13-hallazgos-spike.md).

La correspondencia `título del todo ↔ key de la fase` se resuelve por posición y por texto
normalizado en el traductor de eventos. **La fuente autoritativa del histórico sigue siendo el
array `steps` del JSON final**, no los todos: si el modelo descuidó la lista, el informe igual
queda bien.

### Reglas de la fase 4 (la única que escribe)

Es la fase con riesgo, así que las reglas son explícitas:

1. Solo se actualizan versiones **patch** y **minor** dentro del mismo major.
2. Un major **nunca** entra al PR. Va a `dependency_updates.deferred` con el link a la guía
   de migración.
3. Si un minor tiene breaking changes documentados (pasa: no todos respetan semver), **no
   entra** y se difiere con el motivo.
4. Solo se tocan archivos de la allowlist de manifiestos/lockfiles ([04](./04-proveedores-ia-opencode.md)).
   El resto está denegado a nivel de permisos de opencode.
5. El lockfile se regenera **sin ejecutar scripts de paquetes**
   (`npm install --package-lock-only`). Ejecutar `npm install` completo correría código
   arbitrario de terceros dentro del contenedor.
6. Si no se puede regenerar el lockfile de forma segura, se actualiza solo el manifiesto y
   se anota en `limitations`.
7. Toda actualización aplicada debe listar en qué evidencia se basó para considerarla segura.

### Reglas de la fase 5 (investigación)

Acá es donde el agente aporta el valor que un `npm outdated` no da. Ejemplo canónico:

> Detecta `runtime: nodejs18.x` en `serverless.yml` → investiga el calendario de soporte de
> AWS Lambda → encuentra la fecha de fin de soporte → recomienda migrar a `nodejs20.x` o
> superior → **incluye el link oficial de AWS**.

🟢 Regla dura: **toda afirmación sobre EOL, deprecación o fin de soporte debe venir con una
URL oficial**. Si el agente no la puede verificar con `webfetch`, baja la confianza a `low` y
lo dice explícitamente. Un informe con fechas inventadas es peor que no tener informe.

## Definición del agente en opencode

`/work/repo/.opencode/agents/maintainer.md`, generado por el runner:

```markdown
---
description: Auditoria de mantenimiento de repositorios
mode: primary
temperature: 0.1
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  webfetch: allow
  external_directory: deny
---

(system prompt — ver abajo)
```

`temperature: 0.1` 🟡 — queremos consistencia y determinismo, no creatividad.

## System prompt (v1)

> ⚠️ **La fuente de verdad es [`packages/contracts/src/prompts/maintenance.v1.md`](../packages/contracts/src/prompts/maintenance.v1.md)**,
> no esta copia. El prompt se carga desde ahí en tiempo de ejecución y su versión
> (`AGENT_VERSION = "maintenance@1"`) se congela en `runs.agent_version`.
>
> Lo de abajo queda como referencia legible dentro del diseño. Si divergen, manda el archivo.

```
Sos un auditor de mantenimiento de software. Tu trabajo es evaluar el estado de
mantenimiento de este repositorio y producir un informe accionable y honesto.

## Contexto
- Repositorio: {{owner}}/{{repo}}
- Rama: {{branch}} (commit {{sha}})
- Directorio de trabajo: /work/repo

## Alcance
Tu foco es MANTENIMIENTO. Eso incluye:
- Actualizacion de dependencias.
- Vigencia del runtime y del entorno (versiones EOL o proximas a EOL).
- Salud del codigo desde el punto de vista de mantenibilidad: duplicacion,
  acoplamiento, tooling, consistencia, configuracion.

Esta EXPLICITAMENTE fuera de tu alcance:
- Vulnerabilidades de seguridad. Si encontras algo, anotalo en `out_of_scope_notes`
  y segui; NO lo conviertas en un hallazgo.
- Proponer funcionalidades nuevas.
- Implementar refactors. Los recomendas, no los hacer.

## Lista de tareas
Lo PRIMERO que hacés es crear tu lista de tareas con EXACTAMENTE estas 7 entradas, en
este orden y con este texto literal:
  1. Reconocimiento del repositorio
  2. Inventario de dependencias
  3. Investigacion de dependencias
  4. Aplicacion de actualizaciones seguras
  5. Analisis de runtime y entorno
  6. Revision de mantenibilidad
  7. Elaboracion del informe
Marcá cada tarea como in_progress al empezarla y completed (o cancelled si la salteás)
al terminarla. Trabajá de a una: nunca tengas dos en in_progress a la vez.
Esta lista es lo que el usuario ve en vivo, asi que mantenela al dia.

## Metodo
Las fases se corresponden una a una con tus tareas. Seguilas en orden:
1. repo-discovery          Reconoce lenguajes, gestores de paquetes, frameworks, CI.
2. dependency-inventory    Inventaria dependencias: version actual vs. ultima disponible.
3. dependency-research     Investiga changelogs y breaking changes de las candidatas.
4. safe-updates            Aplica SOLO actualizaciones seguras (ver reglas).
5. runtime-analysis        Analiza vigencia de runtimes y entorno. Buscá fechas de EOL.
6. maintainability-review  Evalua mantenibilidad del codigo.
7. report-assembly         Consolida el informe.

## Reglas para actualizar dependencias
- Solo patch y minor dentro del mismo major.
- NUNCA apliques un major. Va a `deferred` con el link a la guia de migracion.
- Si un minor documenta breaking changes, no lo apliques: diferilo con el motivo.
- Regenera el lockfile SIN ejecutar scripts de paquetes.
- Solo podes editar manifiestos y lockfiles. Cualquier otro archivo esta denegado.

## Reglas de evidencia
- Toda afirmacion sobre EOL, deprecacion o fin de soporte necesita una URL oficial
  que hayas verificado. Sin URL verificada, marcá confidence: "low" y decilo.
- NUNCA inventes versiones, fechas ni URLs. Si no lo sabes, decí que no lo sabes.
- Cada hallazgo debe apuntar a archivos concretos del repositorio.

## Calidad de los hallazgos
Priorizá pocos hallazgos relevantes por sobre muchos genericos. Un hallazgo sirve si:
- es especifico de ESTE repositorio (no consejo generico),
- explica el impacto concreto de no atenderlo,
- propone un curso de accion claro,
- tiene un esfuerzo estimado realista.
Si el repositorio esta bien mantenido, decilo. Un informe corto y honesto vale mas
que uno inflado.

## Salida
Al terminar devolves UN solo objeto JSON que cumpla el schema provisto.
- `steps` refleja las fases que efectivamente recorriste, con lo que encontraste en cada una.
- `proposed_pull_request` describe el PR que deberia crearse con los cambios que aplicaste.
  NO intentes crear el PR vos: no tenes acceso a GitHub. Solo dejá los archivos modificados.
- `finding_key` debe ser un slug estable y determinista (ej. "runtime-eol:node:18"),
  para poder comparar el mismo hallazgo entre auditorias sucesivas.
```

🟡 El prompt se versiona en `packages/contracts/prompts/maintenance@1.md` y su versión se
guarda en `runs.agent_version`. Cambiar el prompt sin versionarlo rompe la comparabilidad
del histórico.

## Contrato de salida — JSON Schema

Fuente de verdad: esquema Zod en `packages/contracts/src/maintenance-report.ts`, del cual se
deriva el JSON Schema que se le pasa a opencode. Así la validación en el host y la
restricción del modelo no se pueden desincronizar.

✅ **Implementado en la Fase 1.** Zod 4 trae `z.toJSONSchema()` nativo, así que no hace falta
`zod-to-json-schema` como decía la versión anterior de este documento. El schema derivado pesa
**6.634 bytes** en la variante normal y **6.871 bytes** en la estricta destinada a opencode,
cómodo para cualquier proveedor. La corrida real de I5 validó la versión base de 6.279 bytes;
el hardening posterior está cubierto localmente y se reconfirma con el primer run de la Fase 5.

⚠️ Dos detalles que salieron al implementarlo:

- **Sin `id` en `.meta()`.** Registrar un `id` hace que `z.toJSONSchema` emita
  `{ $ref: "#/$defs/..." }` en la raíz en vez del objeto plano, y los proveedores de
  structured output esperan el objeto directo.
- **Zod descarta las claves desconocidas, no rechaza el informe.** Es el comportamiento que
  queremos: si el modelo agrega un campo de más, no tiramos una auditoría entera por eso. El
  `additionalProperties: false` del JSON Schema ya se lo pide al modelo.
- Los opcionales aceptan también `null`: OpenAI exige que todas las propiedades figuren en
  `required` para structured output estricto y representa así los valores ausentes. El mismo
  output debe ser válido al revalidarlo con Zod en el host.
- `steps` exige exactamente las siete fases, en orden y con sus títulos literales. La longitud
  se refleja en JSON Schema y la coherencia de key/título se revalida en el host.

```jsonc
{
  "type": "object",
  "required": ["schema_version", "audit_type", "summary", "steps", "findings"],
  "properties": {

    "schema_version": { "const": "1.0" },
    "audit_type":     { "const": "maintenance" },

    "summary": {
      "type": "object",
      "required": ["health_score", "headline", "overview"],
      "properties": {
        "health_score": { "type": "integer", "minimum": 0, "maximum": 100,
                          "description": "Salud de mantenimiento. 100 = impecable." },
        "headline":     { "type": "string", "maxLength": 160,
                          "description": "Una linea que resume el estado del repo." },
        "overview":     { "type": "string",
                          "description": "Opinion general en markdown, 2-5 parrafos." }
      }
    },

    "stack_detected": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "category"],
        "properties": {
          "name":     { "type": "string" },
          "version":  { "type": "string" },
          "category": { "enum": ["runtime","language","framework","package-manager",
                                 "build-tool","ci","infra","database","testing"] },
          "evidence": { "type": "string", "description": "Archivo donde se detecto." }
        }
      }
    },

    "steps": {
      "type": "array",
      "description": "Las fases recorridas, en orden.",
      "items": {
        "type": "object",
        "required": ["key", "title", "status", "description"],
        "properties": {
          "key":         { "enum": ["repo-discovery","dependency-inventory","dependency-research",
                                    "safe-updates","runtime-analysis","maintainability-review",
                                    "report-assembly"] },
          "title":       { "type": "string" },
          "status":      { "enum": ["completed","skipped","failed"] },
          "description": { "type": "string",
                           "description": "Que se hizo y que se encontro. Markdown." },
          "evidence":    { "type": "array", "items": { "type": "string" } },
          "skip_reason": { "type": "string" }
        }
      }
    },

    "dependency_updates": {
      "type": "object",
      "properties": {
        "applied": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name","from","to","bump"],
            "properties": {
              "name":          { "type": "string" },
              "from":          { "type": "string" },
              "to":            { "type": "string" },
              "bump":          { "enum": ["patch","minor"] },
              "scope":         { "enum": ["prod","dev","peer","optional"] },
              "changelog_url": { "type": "string", "format": "uri" },
              "rationale":     { "type": "string", "description": "Por que es segura." }
            }
          }
        },
        "deferred": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name","from","to","reason"],
            "properties": {
              "name":                 { "type": "string" },
              "from":                 { "type": "string" },
              "to":                   { "type": "string" },
              "bump":                 { "enum": ["major","minor","patch"] },
              "reason":               { "type": "string" },
              "breaking_changes":     { "type": "array", "items": { "type": "string" } },
              "migration_guide_url":  { "type": "string", "format": "uri" },
              "estimated_effort":     { "enum": ["low","medium","high"] }
            }
          }
        },
        "unmaintained": {
          "type": "array",
          "description": "Paquetes sin releases recientes, deprecados o archivados.",
          "items": {
            "type": "object",
            "required": ["name","evidence"],
            "properties": {
              "name":        { "type": "string" },
              "last_release":{ "type": "string" },
              "evidence":    { "type": "string" },
              "alternative": { "type": "string" }
            }
          }
        }
      }
    },

    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["finding_key","category","severity","title","description","recommendation","confidence"],
        "properties": {
          "finding_key":    { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*(:[a-zA-Z0-9._-]+)*$",
                              "description": "Slug estable entre auditorias. Ej: runtime-eol:node:18" },
          "category":       { "enum": ["runtime-eol","dependency","code-quality","duplication",
                                       "build","ci-cd","tooling","documentation","testing",
                                       "configuration","performance","dx"] },
          "severity":       { "enum": ["info","low","medium","high"],
                              "description": "Impacto de mantenimiento, NO de seguridad." },
          "effort":         { "enum": ["low","medium","high"] },
          "confidence":     { "enum": ["low","medium","high"] },
          "title":          { "type": "string", "maxLength": 140 },
          "description":    { "type": "string", "description": "Que pasa y por que importa. Markdown." },
          "recommendation": { "type": "string", "description": "Que hacer al respecto. Markdown." },
          "locations": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["path"],
              "properties": {
                "path": { "type": "string" },
                "line": { "type": "integer", "minimum": 1 },
                "note": { "type": "string" }
              }
            }
          },
          "references": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["title","url"],
              "properties": {
                "title":    { "type": "string" },
                "url":      { "type": "string", "format": "uri" },
                "official": { "type": "boolean" }
              }
            }
          }
        }
      }
    },

    "proposed_pull_request": {
      "type": ["object","null"],
      "description": "null si no se aplico ningun cambio.",
      "properties": {
        "title":        { "type": "string", "maxLength": 100 },
        "body":         { "type": "string", "description": "Cuerpo en markdown." },
        "files_changed":{ "type": "array", "items": { "type": "string" } }
      }
    },

    "out_of_scope_notes": {
      "type": "array",
      "description": "Cosas vistas que no corresponden a mantenimiento (ej. seguridad).",
      "items": {
        "type": "object",
        "required": ["area","note"],
        "properties": {
          "area": { "enum": ["security","feature","architecture","other"] },
          "note": { "type": "string" }
        }
      }
    },

    "limitations": {
      "type": "array",
      "description": "Que no se pudo analizar y por que. Honestidad sobre los limites.",
      "items": { "type": "string" }
    }
  }
}
```

### Validaciones adicionales en el host (Zod, post-schema)

El JSON Schema garantiza forma; estas reglas garantizan sentido:

- 🟢 `findings[].finding_key` único dentro del run.
- 🟢 Toda `references[].url` debe ser `https://`. Se descartan las que no lo sean.
- 🟢 `locations[].path` debe existir en el árbol del repositorio. Si no existe, se degrada
  `confidence` a `low` y se anota. Es el detector barato de alucinaciones.
- 🟢 `proposed_pull_request.files_changed` debe coincidir con el diff real del workspace.
  Si el agente dice haber tocado archivos que no tocó (o al revés), gana el diff real.
- 🟢 Si `dependency_updates.applied` está vacío pero hay diff, se registra la discrepancia.
- 🟢 `severity: "high"` con `confidence: "low"` se degrada a `medium`: no alarmar sin sustento.

### Política de reintentos

```
intento 1: prompt normal
   |-- info.structured valido y pasa Zod -> listo
   |-- StructuredOutputError o Zod falla
        v
intento 2: mismo prompt + "Tu respuesta anterior no cumplio el schema: <errores>.
           Devolve SOLO el JSON corregido."
   |-- falla de nuevo
        v
run -> failed (SCHEMA_INVALID), se guarda el output crudo como artefacto
```

🟢 Máximo **2 intentos**. Más reintentos sobre un modelo que no logra el schema queman
tokens del usuario sin mejorar las chances.

## Auditoría de seguridad (v2) — nota de diseño

No se implementa en v1, pero el modelo de datos ya la contempla (`runs.audit_type`). Cuando
se haga, comparte contenedor, orquestador y streaming; cambia el prompt, el schema y los
permisos (una auditoría de seguridad debería ser **totalmente read-only**: `edit: deny` sin
allowlist y sin PR). Mantener los dos schemas separados y versionados por tipo.
