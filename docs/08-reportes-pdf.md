# 08 — Reporte PDF

## Dónde se genera

🟢 **En el host, no en el contenedor.** El agente devuelve datos; el informe es una
*presentación* de esos datos. Generarlo afuera mantiene el contenedor chico, permite
regenerar el PDF sin volver a correr el agente (útil al cambiar la plantilla) y evita que el
agente influya en el formato del documento.

## Elección de herramienta — 🟡 propuesto

| Opción | Pro | Contra |
|--------|-----|--------|
| **@react-pdf/renderer** ✅ | Sin Chromium. Layout declarativo en JSX. ~20 MB. Determinista. | Subconjunto propio de estilos (no es CSS completo). Markdown hay que renderizarlo a mano. |
| Playwright / Puppeteer → PDF | CSS completo, HTML reutilizable con la vista web. | Descarga ~300 MB de Chromium, más consumo de RAM, más superficie de ataque. |
| PDFKit | Mínimo, sin dependencias pesadas. | Layout imperativo: posicionar todo a mano es tedioso. |

**Recomendación: `@react-pdf/renderer`.** El informe tiene una estructura fija y conocida,
así que la limitación de estilos no molesta; y no arrastrar un navegador headless al servidor
vale mucho en simplicidad de despliegue.

El markdown de `overview`, `description` y `recommendation` se convierte con un renderer
acotado (párrafos, listas, `código inline`, negrita, links). 🟢 **No** se soporta markdown
arbitrario: el prompt le pide al agente que use solo esos elementos.

## Estructura del documento

```
PORTADA
  Logo / titulo "Auditoria de mantenimiento"
  owner/repo  ·  rama  ·  commit (7 chars)
  Fecha de ejecucion  ·  Duracion
  Modelo utilizado (proveedor/modelo)  ·  Version del agente
  HEALTH SCORE grande + headline

1. RESUMEN EJECUTIVO
   overview (markdown)
   Tabla: hallazgos por severidad  |  deps actualizadas  |  deps diferidas

2. STACK DETECTADO
   Tabla: componente | version | categoria | evidencia

3. ACTUALIZACIONES DE DEPENDENCIAS
   3.1 Aplicadas en el PR      tabla: paquete | de -> a | tipo | por que es segura
   3.2 Diferidas               tabla: paquete | de -> a | motivo | esfuerzo | guia
   3.3 Sin mantenimiento       tabla: paquete | ultimo release | alternativa

4. HALLAZGOS
   Uno por bloque, ordenados por severidad y luego por esfuerzo ascendente:
     [SEVERIDAD] Titulo
     Categoria · Esfuerzo · Confianza
     Descripcion
     Recomendacion
     Ubicaciones:  path:line
     Referencias:  titulo (url)

5. PULL REQUEST GENERADO
   Numero, titulo, link, archivos modificados
   (o "No se genero PR" con el motivo)

6. TRAZA DE LA AUDITORIA
   Los 7 pasos con su estado y descripcion.
   Es la seccion que responde "¿que hizo realmente el agente?"

7. LIMITACIONES Y NOTAS
   limitations[]
   out_of_scope_notes[]  (con aclaracion de que seguridad se audita aparte)

PIE DE PAGINA (todas las paginas)
  owner/repo · run <id> · pagina X de Y
  "Informe generado automaticamente con asistencia de IA. Revisar antes de actuar."
```

🟢 El disclaimer del pie es obligatorio. El informe puede contener errores del modelo y eso
tiene que estar visible en el documento, no solo en la UI.

## Ordenamiento de hallazgos

```
severidad DESC (high > medium > low > info)
  luego esfuerzo ASC (low > medium > high)   <- quick wins primero
    luego confianza DESC
```

Racional: dentro de la misma severidad, lo primero que el usuario quiere ver es lo que puede
resolver rápido.

## Flujo de generación

```
1. Run llega a `generating_report`
2. Se lee runs.result_json (ya validado)
3. Se renderiza a un Buffer con @react-pdf/renderer
4. Se escribe en ARTIFACTS_DIR/<runId>/reporte-mantenimiento.pdf
5. Se calcula sha256 y tamaño
6. INSERT en run_artifacts (kind: 'report_pdf')
7. Evento SSE run.report_ready
```

🟢 Si el paso 3 falla, el run **no** falla: queda `completed`, se anota un warning y el
usuario puede pedir la regeneración. El valor del run está en el PR y el JSON; el PDF es
presentación.

### Endpoint de regeneración

```
POST /api/runs/:id/report    -> regenera el PDF desde result_json
```

Útil cuando se mejora la plantilla y se quieren actualizar informes viejos sin gastar tokens.
Requiere que `result_json` exista.

## Descarga

```
GET /api/runs/:id/artifacts/:artifactId
```

- 🟢 Verifica que el artefacto pertenezca a un run del usuario autenticado. Nada de servir
  archivos por path.
- 🟢 `Content-Disposition: attachment; filename="manteiner-<owner>-<repo>-<fecha>.pdf"`.
- 🟢 Se sirve desde `ARTIFACTS_DIR` resolviendo la ruta y **verificando que quede dentro** del
  directorio (defensa contra path traversal aunque el path venga de la DB).

## Artefactos adicionales

Junto al PDF se guardan:

| kind | Qué es | Para qué |
|------|--------|----------|
| `result_json` | El informe estructurado validado | Consumo programático, integraciones futuras. |
| `patch` | `git diff` del workspace | 🟡 **Desactivado por defecto** (`STORE_PATCH_ARTIFACT=false`): el PR ya es el registro canónico del diff, y guardarlo duplicaría código del usuario en nuestro disco. Se activa para depuración. |
| `agent_log` | Log del contenedor | Solo en runs fallidos. Depuración. |

## Tipografía y presentación — 🟡

- Fuente: **Inter** (o la del sistema) embebida; monoespaciada **JetBrains Mono** para código
  y rutas. `@react-pdf/renderer` exige registrar las fuentes: hay que versionar los `.ttf` en
  el repo para que el build sea reproducible y no dependa de descargarlas en runtime.
- Severidades por color **y** por etiqueta de texto (nunca solo color: el informe se imprime
  en blanco y negro y hay usuarios con daltonismo).
- Márgenes 40 pt, A4. Tablas con ancho fijo por columna: el autolayout de
  `@react-pdf/renderer` con contenido variable da resultados impredecibles.
- Evitar bloques que no puedan partirse entre páginas: un hallazgo largo debe poder cortarse.
