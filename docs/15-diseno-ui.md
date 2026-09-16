# 15 — Diseño de UI

> Propuesta de diseño de producto para Manteiner. Deriva **exclusivamente** de lo que ya está
> definido en `docs/00` a `docs/14`: no inventa capacidades. Cada vista declara de qué endpoint
> se alimenta ([09](./09-api-y-ui.md)), qué estados puede tener ([01](./01-arquitectura.md),
> [02](./02-modelo-de-datos.md)) y qué eventos la mueven ([07](./07-progreso-sse.md)).
>
> Estado: 🟡 propuesta. Las vistas marcadas **P** (principal) son las que se maquetan primero.

---

## 0. Principios visuales

Cinco reglas que resuelven las discusiones antes de que ocurran.

1. **Oscuro por defecto, pero no negro.** El fondo es un gris muy oscuro con una insinuación
   fría. El negro puro (`#000`) contra texto claro genera halo y cansa; además deja sin margen
   para construir profundidad por capas.
2. **La jerarquía se construye con superficie y tipografía, no con líneas.** Los bordes son
   casi invisibles (1px, 6–10% de opacidad). Lo que separa dos bloques es el aire entre ellos.
3. **Un solo acento.** El color de marca se usa para *una* acción por pantalla. Todo lo demás
   es gris. Si dos cosas compiten por ser el acento, ninguna lo es.
4. **El color semántico es información, no decoración.** Rojo/ámbar/azul solo significan
   severidad o estado. Nunca se usan para "dar vida" a un componente.
5. **La animación explica un cambio de estado o no existe.** Nada se mueve por gusto. Toda
   transición responde a: apareció algo, cambió algo, o el sistema está trabajando.

Una sexta, específica de este producto: **la app no debe presentar todo con la misma
autoridad.** Un hallazgo con `confidence: low` tiene que *verse* menos firme que uno con
`confidence: high` ([09](./09-api-y-ui.md)). Es una decisión visual, no un texto legal.

---

## 1. Sistema de diseño

### 1.1 Color

> **Revisión 2.** La primera paleta usaba colores saturados (`#7C87FF`, `#F2555F`, `#3ECF8E`).
> En pantalla se leían pesados y genéricos: varios hues brillantes compitiendo en la misma
> vista producen exactamente el "aspecto de IA" que este diseño quiere evitar. La regla dura
> pasó a ser: **ningún color saturado ocupa área**. Los hues viven en lavados de 6–13% de
> opacidad, bordes de 20–26% y texto apagado (~35% de saturación). Sin glows, sin gradientes
> brillantes, sin rellenos sólidos de croma alta salvo uno.

Paleta base (dark). Los nombres son los tokens CSS.

| Token | Valor | Uso |
|---|---|---|
| `--bg-canvas` | `#0A0B0D` | Fondo de la app. La capa más profunda. |
| `--bg-sunken` | `#07080A` | Huecos: inputs, code blocks, tracks de progreso. |
| `--bg-surface` | `#101216` | Tarjetas, paneles, filas de lista. |
| `--bg-raised` | `#16191F` | Elementos sobre tarjeta: chips, hover de fila. |
| `--bg-overlay` | `#1A1E25` | Modales, popovers, dropdowns, command palette. |
| `--border-hair` | `rgba(255,255,255,0.06)` | Separador por defecto. Casi no se ve. |
| `--border-soft` | `rgba(255,255,255,0.10)` | Borde de tarjeta y de input en reposo. |
| `--border-strong` | `rgba(255,255,255,0.18)` | Hover de input, borde de elemento activo. |
| `--text-primary` | `#E9ECF1` | Títulos y contenido. Nunca `#FFF`. |
| `--text-secondary` | `#98A0AD` | Metadatos, descripciones, labels. |
| `--text-tertiary` | `#626A78` | Texto deshabilitado, placeholders, timestamps. |
| `--accent` | `#8189C8` | Marcas, barras, bordes, foco. Indigo apagado, no violeta. |
| `--accent-fill` | `#575E9C` | **El único relleno sólido de la app**: el botón primario. |
| `--accent-hover` | `#636BAB` | Hover del relleno. |
| `--accent-text` | `#A9B0DC` | Links y texto de acento sobre oscuro. |
| `--accent-wash` | `rgba(129,137,200,0.12)` | Fondo de estado activo/seleccionado. |
| `--accent-line` | `rgba(129,137,200,0.26)` | Borde de elemento acentuado. |

Semánticos. Cada uno tiene un par: color de texto/ícono y un *wash* de fondo al 12%.

| Token | Valor | Significado en Manteiner |
|---|---|---|
| `--sev-high` | `#CF7C83` | `severity: high` · run `failed` · credencial inválida |
| `--sev-medium` | `#CFA469` | `severity: medium` · `agent.retrying` · run `timed_out` |
| `--sev-low` | `#7FA3C4` | `severity: low` |
| `--sev-info` | `#78818F` | `severity: info` · paso `skipped` |
| `--ok` | `#7CB194` | Paso `completed` · run `completed` · PR creado |
| `--warn-conf` | `#B79E62` | Confianza baja (distintivo de `confidence: low`) |

Cada semántico aparece siempre en la misma receta, la del banner de "instalación revocada":
**lavado de fondo al 6–9%, borde al 20–22%, texto en el color apagado.** Nunca un relleno
sólido de color.

Health score — la escala es continua pero se lee en cuatro tramos:

| Rango | Color | Lectura |
|---|---|---|
| 90–100 | `#7CB194` | Impecable |
| 75–89 | `#93B489` | Sano |
| 50–74 | `#CFA469` | Atención |
| 0–49 | `#CF7C83` | Crítico |

🟢 El número del score **nunca** aparece sin su etiqueta textual ("Sano", "Atención"). El color
solo no es accesible, y un 72 sin contexto no dice nada.

🟢 **El número va en `--text-primary`, no en el color del tramo.** El hue lo lleva el arco del
anillo y la etiqueta. Un número grande y coloreado en cada tarjeta convertía el dashboard en un
semáforo; con el arco fino alcanza para leer el estado de un vistazo. Lo mismo vale para los
KPI del informe: las cifras son neutras y el matiz queda en la barra o en el pie.

### 1.2 Tipografía

Dos familias, ambas variables, ambas en Google Fonts.

| Rol | Familia | Por qué |
|---|---|---|
| Interfaz | **Instrument Sans** | Grotesca moderna, proporciones ajustadas, muy legible a 12–13px. Se eligió por sobre Inter/Roboto, que están tan usadas que no aportan carácter. |
| Código y datos | **JetBrains Mono** | `owner/repo`, versiones `1.2.3 → 1.4.0`, paths, SHA, el device code, diffs. |

Regla dura 🟢: **todo lo que el usuario podría copiar o comparar caracter a caracter va en
mono.** Nombres de repo, versiones, rutas de archivo, SHA de commit, el código del device flow.
No es estético: es lo que hace que `1.14.2` y `1.4.12` se distingan de un vistazo.

Escala (tamaño / interlineado / peso / tracking):

| Token | Valor | Uso |
|---|---|---|
| `display` | 34 / 40 / 600 / -0.022em | Health score, código del device flow |
| `h1` | 24 / 31 / 600 / -0.018em | Título de vista |
| `h2` | 18 / 25 / 600 / -0.012em | Título de sección y de tarjeta |
| `h3` | 15 / 22 / 600 / -0.006em | Título de hallazgo, título de paso |
| `body` | 14 / 22 / 400 / 0 | Texto por defecto |
| `body-sm` | 13 / 20 / 400 / 0 | Descripciones dentro de tarjetas |
| `caption` | 12 / 17 / 450 / 0.004em | Metadatos, timestamps |
| `label` | 11 / 14 / 620 / 0.075em uppercase | Labels de sección y de columna |
| `mono` | 13 / 20 / 450 / 0 | Código inline, versiones, paths |
| `mono-lg` | 15 / 24 / 500 / 0 | Bloques de código y diff |

Reglas: máximo **tres** tamaños por bloque visual. El ancho de lectura de prosa (`overview`,
`description`, `recommendation`) se topa en **68ch**. Los números en tablas usan
`font-variant-numeric: tabular-nums`.

### 1.3 Espaciado y grilla

Base **4px**. Escala: `4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 72 · 96`.

| Contexto | Valor |
|---|---|
| Padding interno de tarjeta | 20px (24px en tarjetas protagonistas) |
| Separación entre tarjetas | 12px en listas densas, 16px en grillas |
| Separación entre secciones | 40px |
| Padding de la vista | 32px horizontal, 28px superior |
| Sidebar | 244px fijo |
| Ancho máximo de contenido | 1180px, centrado |
| Ancho de lectura de prosa | 68ch |

### 1.4 Forma, profundidad, textura

- Radios: `6px` chips e inputs chicos · `10px` botones e inputs · `14px` tarjetas ·
  `18px` modales y paneles grandes · `999px` pills y avatares.
- **Sin sombras difusas.** La profundidad se logra con: cambio de superficie + borde hairline +
  un realce interno superior `inset 0 1px 0 rgba(255,255,255,0.045)`. Solo los overlays
  (modal, popover, command palette) llevan sombra real: `0 16px 48px rgba(0,0,0,0.55)`.
- Un gradiente ambiental muy tenue detrás del header de cada vista
  (`radial-gradient` del acento al 5%, 600px de radio) da sensación de luz sin ensuciar.
- Grano/ruido opcional al 1.5% de opacidad sobre el canvas: rompe el banding de los gradientes
  en pantallas OLED. 🟡 Evaluar en implementación.

### 1.5 Motion

| Token | Duración | Curva | Uso |
|---|---|---|---|
| `--t-micro` | 120ms | `cubic-bezier(.3,0,.2,1)` | Hover, foco, cambio de color |
| `--t-base` | 180ms | `cubic-bezier(.2,0,0,1)` | Aparición de chips, tooltips, checks |
| `--t-panel` | 260ms | `cubic-bezier(.16,1,.3,1)` | Modales, drawers, acordeones |
| `--t-page` | 380ms | `cubic-bezier(.16,1,.3,1)` | Transición entre vistas |
| `--t-ambient` | 2–6s | `ease-in-out` infinito | Pulso de "en vivo", shimmer |

Patrones de movimiento propios de esta app:

- **Entrada escalonada de listas.** Tarjetas y filas entran con `opacity 0→1` + `translateY 6px→0`,
  con `40ms` de retraso incremental, tope de 8 elementos. Más que eso se percibe lento.
- **Paso que se activa.** Cuando un step pasa a `running`: el punto de estado crece de 6 a 8px,
  el título pasa de `--text-secondary` a `--text-primary` y aparece un halo que respira
  (2.4s, opacidad 0.2→0.5→0.2). Es la única animación infinita permitida junto al shimmer.
- **Paso que se completa.** El punto se convierte en check con un `scale 0.6→1` de 180ms y el
  cronómetro del paso se fija con un fade. Sin rebote: el rebote resta seriedad.
- **Conteo de números.** Health score y contadores animan de 0 al valor final en 700ms con
  `ease-out`. Solo la primera vez que se montan.
- **Mutación del run a informe.** Al llegar `run.completed`, la lista de pasos se comprime a
  una barra de traza (altura animada, 420ms) y el informe entra por debajo. **No hay recarga ni
  cambio de ruta** ([09](./09-api-y-ui.md)).
- **Anillo del score.** Se dibuja con `stroke-dashoffset` animado, 900ms, `ease-out`.

🟢 Todo esto vive dentro de `@media (prefers-reduced-motion: reduce)`: con la preferencia activa
los estados cambian igual pero de forma instantánea, y las animaciones infinitas se reemplazan
por un estado estático (el punto de "running" queda con el halo fijo).

### 1.6 Iconografía

Lucide, trazo `1.5px`, tamaños `14 / 16 / 20`. Nunca se usa un ícono solo cuando la acción es
destructiva o poco frecuente: lleva texto o, como mínimo, tooltip con atajo.

---

## 2. Shell de la aplicación

Todo lo autenticado vive dentro del mismo marco.

```
+------------+--------------------------------------------------------------+
|            |  Topbar: breadcrumb · acciones contextuales · avatar          |
|  Sidebar   +--------------------------------------------------------------+
|  244px     |                                                              |
|            |  Contenido (max 1180px, centrado)                            |
|  logo      |                                                              |
|  ---       |                                                              |
|  Repos     |                                                              |
|  Runs      |                                                              |
|  Config    |                                                              |
|  ---       |                                                              |
|  [run      |                                                              |
|   activo]  |                                                              |
|  avatar    |                                                              |
+------------+--------------------------------------------------------------+
```

**Sidebar**
- Logo + wordmark arriba (56px de alto, alineado con el topbar).
- Navegación: `Repositorios`, `Ejecuciones`, `Configuración`. Item activo: fondo `--accent-wash`,
  texto `--text-primary`, y una barra de 2px a la izquierda que se desliza entre items
  (`--t-base`) en vez de aparecer y desaparecer.
- **Bloque de run activo**, fijo al fondo por encima del usuario. Solo existe si hay un run en
  vuelo. Muestra: punto pulsante, `owner/repo` en mono truncado, paso actual, cronómetro.
  Es un link a la vista en vivo. Es la pieza que hace que el usuario pueda irse de la pantalla
  del run sin perderlo de vista.
- Chip de usuario abajo: avatar de GitHub, `githubLogin`, menú con *Configuración* y
  *Cerrar sesión* (`POST /api/auth/logout`).
- Colapsable a 64px (solo íconos) con `[`. Estado persistido en `localStorage`.

**Topbar**
- Breadcrumb: `Repositorios / owner/repo / Run #23`. El segmento del repo en mono.
- Acciones contextuales alineadas a la derecha, siempre en el mismo lugar.
- Buscador / command palette con `⌘K` `Ctrl+K`: saltar a repo, disparar auditoría, ir a
  configuración. 🟡 v1.1, pero el lugar se reserva desde ahora.

**Banners globales** (entre topbar y contenido, apilables, máximo 2 visibles):
- Credencial de proveedor inválida → link a Configuración.
- Refresh token de ChatGPT vencido → botón "Reconectar" que abre el device flow.
- Instalación de GitHub revocada → link al repo afectado.

Todos son `role="status"`, persistentes (no se auto-cierran) y descartables solo cuando el
problema deja de aplicar.

**Toasts**: esquina inferior derecha, apilados, 4s, con acción opcional. Se usan para
confirmaciones de bajo riesgo (PR abierto, PDF generado, repo vinculado). Nunca para errores
que requieran acción — esos son banner o inline.

---

## 3. Inventario de vistas

| # | Vista | Ruta | Prioridad | Fase |
|---|---|---|---|---|
| V1 | Login | `/login` | **P** | 2 |
| V2 | Onboarding | `/onboarding` | **P** | 3–4 |
| V3 | Dashboard de repositorios | `/` | **P** | 3 |
| V4 | Run en vivo | `/runs/:id` | **P** | 6 |
| V5 | Informe del run | `/runs/:id` (terminado) | **P** | 8 |
| V6 | Detalle e histórico del repo | `/repos/:id` | secundaria | 6 |
| V7 | Configuración | `/settings` | secundaria | 4 |
| V8 | Visor de diff | `/runs/:id/diff` | secundaria | 7 |
| V9 | Vincular repositorios (modal) | sobre `/` | secundaria | 3 |
| V10 | Ejecuciones (todas) | `/runs` | secundaria | 6 |
| V11 | Tendencia de hallazgos | `/repos/:id/trend` | v1.1 | — |
| V12 | Errores de aplicación | `/404`, sesión expirada | secundaria | — |

---

## V1 · Login — **P**

**Propósito.** Una pantalla, un botón. Explicar en una línea qué hace la app y qué permisos va
a pedir ([09](./09-api-y-ui.md)).

**Datos.** `GET /api/auth/github` (redirect).

**Layout.** Pantalla completa sin shell. Columna centrada de 400px máximo, ópticamente
centrada (48% de la altura, no 50%: el centro geométrico se percibe bajo).

**Componentes**

1. **Marca** — logotipo 32px + wordmark en `h1`. Debajo, una línea en `body` `--text-secondary`:
   *"Auditorías de mantenimiento para tus repositorios, ejecutadas por un agente de IA."*
2. **Botón primario** — `Continuar con GitHub`, ancho completo, 44px de alto, ícono de GitHub a
   la izquierda. Es el único elemento con color de acento en toda la pantalla.
3. **Nota de permisos** — `caption` `--text-tertiary`, tres líneas con viñeta:
   *lee tu perfil público · vos elegís a qué repos accede · nunca escribe en tu rama principal*.
   Es la primera vez que el usuario decide confiar: decirlo acá evita el abandono en la pantalla
   de OAuth de GitHub.
4. **Pie** — links a términos y privacidad, `caption`.

**Ambiente.** Un gradiente radial del acento al 6% detrás de la columna, y un grid de puntos de
32px al 3% de opacidad que se desvanece hacia los bordes. Nada más.

**Estados**
- *Cargando*: el botón pasa a spinner + "Redirigiendo a GitHub…", deshabilitado.
- *OAuth cancelado* (`?error=access_denied`): alerta inline sobre el botón, tono neutro,
  *"No se completó la autorización. Podés intentarlo de nuevo."*
- *Sesión expirada* (llegó redirigido): banner discreto arriba de la marca.

**Animación.** Entrada: marca, botón y nota con `translateY 8px→0` escalonados a 60ms.

**A11y.** El botón es el primer elemento focuseable. `autofocus`. Contraste del botón ≥ 4.5:1.

---

## V2 · Onboarding — **P**

**Propósito.** Llevar al usuario de "recién logueado" a "puede disparar un run". Tres
requisitos, completables **en cualquier orden**, pero los tres obligatorios
([09](./09-api-y-ui.md)).

**Datos.** `GET /api/me` → `onboarding: { hasProvider, hasInstallation, hasRepos }`.

**Layout.** Sin sidebar (todavía no hay a dónde navegar). Columna de 560px centrada, con un
riel de progreso vertical a la izquierda de la columna.

### V2.0 · Riel de progreso

Tres nodos conectados por una línea. Cada nodo: círculo de 24px con número, o check cuando está
completo. El paso activo tiene anillo de acento; los completos, relleno `--ok` al 12% y check.
La línea entre nodos se rellena progresivamente (`--t-panel`).

🟢 Como el orden es libre, los pasos completados son **clickeables** para volver a verlos, y el
botón *Continuar* siempre lleva al primer paso incompleto.

### V2.1 · Paso 1 — Conectar proveedor de IA

**Datos.** `GET /api/providers/catalog`, `POST /api/providers`,
`POST /api/providers/oauth/:providerId/start`.

**Componentes**

1. **Lista de opciones de proveedor** — tarjetas de radio apiladas (no un `<select>`): el usuario
   está eligiendo con qué credencial va a trabajar, merece ver las opciones.
   Cada tarjeta: logo del proveedor 20px, nombre, sublínea explicativa, badge opcional.
   - `OpenAI · cuenta ChatGPT Plus/Pro` — badge **Recomendado** en acento.
   - `OpenAI · API key de plataforma`
   - `Anthropic · API key`
   - `OpenRouter`, `Groq`, … (del catálogo)
   - Proveedores OAuth no implementados (Claude Pro/Max, Copilot, xAI): **visibles pero
     deshabilitados**, opacidad 45%, badge `Próximamente`. 🟢 Es información útil, no un bug
     ([09](./09-api-y-ui.md)).
   - Estado seleccionado: borde `--accent`, fondo `--accent-wash`, y el contenido del paso se
     expande *debajo de la tarjeta elegida* (acordeón, `--t-panel`) en vez de navegar a otra
     pantalla. Se pierde menos contexto.

2. **Rama A — API key**
   - Input de tipo password con botón ojo, ancho completo, mono.
   - Texto de ayuda con link a dónde obtener la key en el proveedor.
   - Botón `Validar y guardar`. Durante la validación (que levanta un contenedor efímero,
     [04](./04-proveedores-ia-opencode.md)) el botón muestra *"Verificando con el proveedor…"*
     con una barra indeterminada. **Puede tardar varios segundos**: hay que decir por qué.
   - Éxito: la tarjeta se colapsa a una fila con check, `label` del proveedor y `••••9f2a`.
   - Error `PROVIDER_AUTH_FAILED`: mensaje inline bajo el input, borde `--sev-high`, el input
     conserva el valor.

3. **Rama B — Device flow de ChatGPT** (la pantalla con más cuidado del onboarding)
   - Instrucción numerada en dos pasos.
   - **URL** en una fila con fondo `--bg-sunken`, mono, y botón `Abrir` (abre en pestaña nueva).
   - **El código, protagonista**: `display` mono, letra espaciada (`0.12em`), con el guion
     visible, en un recuadro de `--bg-sunken` con borde punteado. Botón `Copiar` que hace
     morph a check por 1.2s. Tamaño mínimo 34px: se copia a mano.
   - **Estado de espera**: punto pulsante + *"Esperando autorización…"* + cuenta regresiva
     `mm:ss`. El contador cambia a `--sev-medium` bajo 2:00 y a `--sev-high` bajo 0:30.
   - El polling lo hace el backend; el frontend consulta
     `GET /api/providers/oauth/:providerId/status` cada 2s
     ([09](./09-api-y-ui.md)). Si el usuario cierra la pestaña, el flujo sigue: al volver, la
     pantalla se rehidrata del estado del servidor.
   - `authorized` → el bloque entero hace una transición a estado de éxito (check que se dibuja,
     fondo `--ok` al 8%) y avanza solo tras 900ms.
   - `expired` → el código se tacha, aparece `Generar código nuevo` **sin salir de la pantalla**.
   - `failed` → error inline con el `code` traducido y botón de reintento.

4. **Selector de modelo** — aparece recién cuando hay credencial activa.
   - Lista filtrable. Por modelo: nombre, id en mono, contexto (`128k`), badge `tool calling`.
   - 🟢 Los modelos **sin tool calling se filtran y no se muestran**: el agente los requiere
     ([04](./04-proveedores-ia-opencode.md)). Nota al pie explicando que la lista puede ser más
     corta que el catálogo público del proveedor, porque sale de `config.providers()` ya
     autenticado.
   - Costo por millón de tokens si el catálogo lo trae; si la credencial es de suscripción,
     se omite la columna (con suscripción viene `cost: 0`, [13](./13-hallazgos-spike.md)).

### V2.2 · Paso 2 — Instalar la GitHub App

- Explicación de permisos **antes** del redirect, en una tarjeta con ícono de escudo:
  *"Manteiner pide permiso de escritura de contenido para poder crear la rama del PR. Nunca
  escribe en tu rama principal ni hace merge."* ([03](./03-autenticacion-github.md))
- Lista de 3 permisos con ícono y una línea cada uno.
- Botón `Instalar en GitHub` (`GET /api/github/install-url`).
- Estado de espera al volver: *"Confirmando la instalación…"* con skeleton, mientras
  `/api/github/setup` resuelve.

### V2.3 · Paso 3 — Vincular repositorios

- `GET /api/github/available-repos`.
- Buscador con filtro instantáneo (client-side) + contador de seleccionados.
- Filas con checkbox: `owner/repo` en mono, chip de lenguaje con punto de color, rama por
  defecto, visibilidad (privado/público), *actualizado hace X*.
- Selección múltiple con `Shift+click` para rangos.
- Barra inferior sticky: *"3 repositorios seleccionados"* + `Vincular` (`POST /api/repos`).
- Vacío: *"No hay repositorios disponibles"* + botón `Ajustar permisos en GitHub`.

**Cierre.** Al completarse los tres, transición a pantalla completa de bienvenida: check grande,
*"Todo listo"*, y un botón `Auditar mi primer repositorio` que abre el dashboard con el selector
de repo ya enfocado. 🟢 El onboarding termina en una acción, no en una pantalla vacía.

---

## V3 · Dashboard de repositorios — **P**

**Propósito.** Estado de todos los repos de un vistazo y disparo de auditorías.

**Datos.** `GET /api/repos` (repos + resumen del último run). Un `EventSource` por run activo.

**Layout.** Shell completo. Header de vista + barra de utilidades + grilla de tarjetas.

**Componentes**

1. **Header de vista**
   - `h1` "Repositorios" + contador en `caption`.
   - Acción primaria a la derecha: `Vincular repositorio` (abre V9).
   - Debajo, **fila de métricas** (4 tiles, opcional pero valiosa): *repos vinculados ·
     auditorías este mes · hallazgos abiertos · salud promedio*. Tiles sin borde, separados por
     espacio, número en `h1` y label en `label`. Delta vs. período anterior en verde/rojo chico.
     🟡 Depende de agregados que hoy no tienen endpoint: se calcula en cliente sobre `/api/repos`
     o se pospone.

2. **Barra de utilidades** — buscador (filtra por nombre, instantáneo), filtro por estado
   (`Todos · Con run activo · Con hallazgos altos · Nunca auditados`), orden
   (`Última auditoría · Salud · Nombre`), y toggle grilla/lista. Todo client-side.

3. **Tarjeta de repositorio** — el componente más importante de la vista.

```
+--------------------------------------------------------------------+
|  [] owner/repo                          [ ··· ]   [ Auditar ]      |
|     TypeScript · main · privado                                    |
|                                                                    |
|     ( 72 )   "Dependencias al dia, runtime de Lambda proximo a EOL" |
|     Sano     hace 3 dias · gpt-5.6-sol                             |
|                                                                    |
|     4 hallazgos   2 altos · 2 medios        PR #128 abierto        |
+--------------------------------------------------------------------+
```

   - **Encabezado**: avatar del owner (20px, radio 6), `owner/` en `--text-secondary` y `repo`
     en `--text-primary`, ambos en mono. Menú `···`: *Ver histórico · Configurar modelo ·
     Abrir en GitHub · Desvincular*.
   - **Metadatos**: chip de lenguaje con punto de color, rama por defecto, visibilidad.
   - **Anillo de health score**: 44px, `stroke` de 3px, número centrado en `h2` tabular,
     etiqueta debajo en `label`. El anillo se dibuja al entrar en viewport.
   - **Headline** del último run, máximo 2 líneas con `line-clamp`. Es la frase que el agente
     escribió: merece tamaño `body` y color primario.
   - **Pie**: contador de hallazgos con desglose por severidad en chips minúsculos; chip de PR
     con su número, link directo a GitHub.
   - **Botón `Auditar`**: secundario en reposo; al hacer hover sobre la tarjeta, sube a
     primario. Es el patrón que mantiene la grilla calma y la acción disponible.
   - **Hover de tarjeta**: `--bg-raised`, borde a `--border-soft`, `translateY(-1px)`.
     120ms. Nada de escalas.

4. **Tarjeta con run activo** — la misma tarjeta **muta**, no se reemplaza:
   - Una barra de progreso hairline de 2px cruza el borde superior de la tarjeta, con el
     porcentaje = pasos completados / 7.
   - El área del score se reemplaza por: punto pulsante + paso actual (`steps.updated`) +
     cronómetro corriendo desde `started_at`, en mono.
   - Bajo el paso, la línea `>` con la herramienta en uso (`agent.tool` → `state.title`), en
     `caption` mono `--text-tertiary`, con fade al cambiar.
   - `Auditar` se reemplaza por `Ver en vivo`.
   - Si llega `agent.retrying`: la tarjeta toma borde `--sev-medium` y muestra
     *"Reintentando (2/5) — el proveedor está limitando la tasa"*. 🟢 Sin esto, media hora de
     silencio es indistinguible de un cuelgue ([07](./07-progreso-sse.md)).

5. **Modal de confirmación de auditoría** — se abre al pulsar `Auditar`:
   - Repo, rama y commit que se va a auditar.
   - Modelo a usar, con link a cambiarlo (preferencia por repo, `PATCH /api/repos/:id`).
   - Aviso de lo que va a pasar: *"Se creará una rama y un PR con las actualizaciones seguras.
     Nunca se escribe en `main`."*
   - `Iniciar auditoría` → `POST /api/repos/:id/runs` con `Idempotency-Key`.
     🟢 El botón se deshabilita en el primer click: un doble click no debe generar dos PRs
     ([09](./09-api-y-ui.md)).
   - Errores: `409 RUN_ALREADY_ACTIVE` → *"Este repo ya tiene una auditoría en curso"* + link a
     ella. `412 PROVIDER_NOT_CONFIGURED` → *"Falta configurar el proveedor"* + link a settings.

**Estados**
- *Cargando*: 6 tarjetas skeleton con shimmer diagonal de 1.6s.
- *Sin repos vinculados*: **no es una tabla vacía, es el onboarding** ([09](./09-api-y-ui.md)).
  Ilustración mínima, título, una línea, botón `Vincular repositorio`.
- *Búsqueda sin resultados*: mensaje corto + `Limpiar filtros`.
- *Instalación revocada*: la tarjeta afectada se muestra atenuada, con banner interno
  `--sev-medium` y botón `Reconectar`.

**Responsive.** La tarjeta del run activo ocupa **el ancho completo** (es la hero de la vista);
el resto va en grilla de 2 columnas ≥980px y 1 columna por debajo. Se probaron 3 columnas: a
380px de ancho el `headline` queda en tres líneas y la tarjeta pierde el aire que necesita.
Bajo 768px el sidebar colapsa a un drawer y las tarjetas pasan a modo lista compacta.

---

## V4 · Run en vivo — **P**

**Propósito.** La pantalla protagonista. El usuario tiene que sentir que algo pasa durante
minutos, y entender qué.

**Datos.** `GET /api/runs/:id` para el estado inicial + `EventSource` a
`GET /api/runs/:id/events` con `Last-Event-ID` para replay ([07](./07-progreso-sse.md)).

**Layout.** Dos columnas: pasos (flex 1, máx 720px) + panel lateral de contexto (300px). Bajo
1100px el panel pasa arriba, en horizontal.

**Componentes**

1. **Header del run** — sticky al hacer scroll, se compacta a 56px.
   - Línea 1: `owner/repo` en mono `h2` + chip `Auditoría de mantenimiento`.
   - Línea 2: **chip de estado** con punto (estados de [01](./01-arquitectura.md):
     `queued · preparing · cloning · running · collecting · publishing_pr · generating_report`),
     **cronómetro** en mono corriendo en el cliente desde `started_at`, `provider/model` en mono
     `--text-tertiary`, rama y `commit_sha` a 7 caracteres.
   - Acción: `Cancelar` (secundario destructivo, `DELETE /api/runs/:id`) con confirmación.
   - **Barra de progreso global** de 2px pegada al borde inferior del header, que avanza con los
     pasos completados. En `queued`/`preparing` es indeterminada (shimmer que recorre).

2. **Lista de los 7 pasos** — el corazón de la vista.
   🟢 **Los 7 se muestran desde el principio, en gris.** El usuario ve el recorrido completo y
   cuánto falta ([09](./09-api-y-ui.md)).

```
  [check] Reconocimiento del repositorio                       0:22
          Node 18, pnpm, Next.js 15, GitHub Actions

  [check] Inventario de dependencias                           1:05
          47 dependencias, 12 desactualizadas

  [ () ]  Investigacion de dependencias                        1:47
          > consultando changelog de next@16
          [ ver razonamiento  v ]

  [  o ]  Aplicacion de actualizaciones seguras
  [  o ]  Analisis de runtime y entorno
  [  o ]  Revision de mantenibilidad
  [  o ]  Elaboracion del informe
```

   - **Indicador de estado** (columna fija de 24px, con línea vertical conectora hairline):
     `pending` punto hueco `--text-tertiary` · `running` punto lleno acento con halo que respira ·
     `completed` check `--ok` · `skipped` guion `--sev-info` · `failed` cruz `--sev-high`.
   - **Título**: `h3`. Gris en `pending`, primario en `running` y `completed`.
   - **Duración por paso**, mono `caption`, alineada a la derecha. Aparece al completar.
   - **Descripción**: en vivo es el resumen corto; al cerrar el run se reemplaza por
     `run_steps.description` (markdown del informe). 🟢 La fuente autoritativa del histórico es
     el array `steps` del JSON final, no los todos ([06](./06-agente-mantenimiento.md)).
   - **Línea de herramienta** (`>`): solo en el paso `running`. Muestra `agent.tool.title`
     (*"Reading package.json"*), que ya viene listo para mostrar
     ([07](./07-progreso-sse.md)). Transición: fade-out/in de 120ms al cambiar. Es la señal de
     vida entre pasos.
   - **Panel "ver razonamiento"**: acordeón **cerrado por defecto**, con los deltas de
     `agent.message` throttleados. Fondo `--bg-sunken`, mono 12px, altura máxima 240px con
     auto-scroll al fondo (que se detiene si el usuario scrollea hacia arriba). Contador de
     caracteres/líneas en el header del acordeón. Informativo pero ruidoso: por eso cerrado.
   - **Paso `skipped`**: se muestra atenuado con el `skip_reason` en `caption`.
     🟢 Saltear ≠ fallar ([06](./06-agente-mantenimiento.md)): el ícono y el color lo distinguen.

3. **Panel lateral de contexto**
   - **Actividad de archivos** (`agent.file_edited`): lista de paths tocados, mono, con ícono de
     archivo y badge del tipo (manifiesto/lockfile). Entra con fade + slide.
   - **Stack detectado**: chips que van apareciendo cuando el paso 1 los reporta.
   - **Contadores en vivo**: dependencias revisadas, actualizaciones aplicadas, hallazgos
     provisionales. Los números animan al cambiar.
   - **Costo y tokens** (`tokens_input/output`, `cost_usd`) si el proveedor los provee.
     🟢 Se **oculta** cuando la credencial es de suscripción: viene `cost: 0` y mostrar "$0.00"
     sería mentir ([13](./13-hallazgos-spike.md)).

4. **Estado de conexión** — chip discreto arriba a la derecha del panel:
   `En vivo` (punto verde) · `Reconectando…` (ámbar, pulsante) · `Desconectado` (rojo, con botón
   `Reintentar`). El `EventSource` reconecta solo; el chip existe para que el usuario sepa que
   la falta de movimiento es de la conexión y no del agente.

**Estados especiales**
- `queued`: los 7 pasos en gris, mensaje *"En cola — hay N auditorías por delante"*.
  (`MAX_CONCURRENT_RUNS`, [01](./01-arquitectura.md)).
- `preparing` / `cloning`: paso cero implícito, *"Preparando el entorno…"* con detalle
  (*creando volumen · clonando repositorio · iniciando contenedor*).
- `agent.retrying`: banner ámbar sobre la lista, *"Reintentando (intento 2) — próximo intento en
  0:12"*, con cuenta regresiva.
- `collecting` / `publishing_pr` / `generating_report`: se agregan como **pasos de sistema**
  al final de la lista, con estilo distinto (íconos de engranaje, color `--text-secondary`), para
  que quede claro que son de la app y no del agente.
- `failed` / `timed_out`: ver V5.2.
- `cancelled`: la lista se congela con los pasos como quedaron, banner neutro y botón
  `Volver a auditar`.

**Transición al informe.** Al llegar `run.completed`, se cierra el `EventSource`
(🟢 si no, reconecta para siempre, [07](./07-progreso-sse.md)) y la vista **muta sin recargar**:
la lista de pasos se comprime a una barra de traza colapsada, y el informe entra desde abajo
(420ms). El score se anima de 0 al valor final.

---

## V5 · Informe del run — **P**

**Propósito.** El resultado. Tiene que ser legible, ordenado por lo que el usuario puede
accionar, y honesto sobre su propia incertidumbre.

**Datos.** `GET /api/runs/:id` (run + steps + findings + artefactos).

### V5.1 · Informe completo

**Cabecera del informe**

```
+---------------------------------------------------------------------+
|                                                                     |
|    ( 72 )     "Dependencias al dia, pero el runtime de Lambda       |
|     Sano       esta proximo a su fin de soporte"                    |
|               15 sep 2026, 14:32 · 6m 12s · gpt-5.6-sol · main@a3f9c1|
|                                                                     |
|  [ Ver PR #128 ]  [ Descargar PDF ]  [ Ver diff ]  [ Volver a auditar ]|
+---------------------------------------------------------------------+
```

- Anillo de score 72px con animación de dibujado + conteo del número.
- `headline` en `h1` (máx 160 caracteres por contrato), ancho de lectura limitado.
- Metadatos congelados del run en `caption` mono: fecha, duración, `provider/model`,
  `agent_version`, rama y `commit_sha`. 🟢 Se muestran porque el histórico debe ser
  interpretable cuando el usuario cambia de modelo ([02](./02-modelo-de-datos.md)).
- Barra de acciones: `Ver PR #128` (primario, si existe), `Descargar PDF`
  (`GET /api/runs/:id/artifacts/:id`), `Ver diff` (V8), `Volver a auditar`.
  Si el PDF falló, el botón muestra `Regenerar PDF` (`POST /api/runs/:id/report`) con un ícono
  de advertencia. 🟢 Un fallo en el PDF no invalida el run ([01](./01-arquitectura.md)).

**Tabs** — sticky bajo la cabecera, indicador que se desliza entre pestañas.

| Tab | Contenido |
|---|---|
| **Resumen** | `overview` en markdown + stack detectado + tablas de dependencias |
| **Hallazgos** | Lista filtrable, con contador por severidad en el tab |
| **Traza** | Los 7 pasos con su descripción final |
| **Limitaciones** | `limitations[]` + `out_of_scope_notes[]` |

#### Tab Resumen

1. **Fila de métricas** — 4 tiles: *hallazgos por severidad* (mini barra apilada),
   *dependencias actualizadas*, *diferidas*, *sin mantenimiento*.
2. **Overview** — markdown renderizado a 68ch, con estilos propios: `p`, `ul/ol`, `code` inline
   en mono con fondo `--bg-sunken`, `strong`, y links que abren en pestaña nueva con ícono.
3. **Stack detectado** — grilla de chips agrupados por `category` (runtime, language, framework,
   package-manager, build-tool, ci, infra, database, testing). Cada chip: ícono de la categoría,
   nombre, versión en mono. Tooltip con `evidence` (el archivo donde se detectó).
4. **Dependencias — tres tablas en un acordeón, la primera abierta.**
   - **Aplicadas en el PR**: `paquete | de → a | tipo | scope | por qué es segura`.
     El `de → a` en mono con la flecha en `--text-tertiary` y el bump coloreado
     (patch = verde tenue, minor = azul). `changelog_url` como ícono de link al final de la fila.
   - **Diferidas**: `paquete | de → a | motivo | esfuerzo | guía de migración`. El chip `major`
     en `--sev-medium`. Los `breaking_changes[]` se despliegan al expandir la fila.
   - **Sin mantenimiento**: `paquete | último release | evidencia | alternativa`. Fila con
     tratamiento de advertencia sutil.
   - Cada tabla con su contador en el header del acordeón. Vacía → una línea, no una tabla vacía.

#### Tab Hallazgos

- **Barra de filtros** sticky: chips multi-selección por `severity`, `category`, `effort`,
  `confidence`. Cada chip muestra su contador. Un botón `Limpiar`.
- **Orden por defecto**: `severidad DESC → esfuerzo ASC → confianza DESC`, el mismo que el PDF
  ([08](./08-reportes-pdf.md)). *Quick wins primero.* Selector para cambiar a *Por categoría*.
- **Tarjeta de hallazgo** (colapsada por defecto, expandible; `Shift+click` expande todas):

```
+---------------------------------------------------------------------+
| [ALTA]  El runtime nodejs18.x de Lambda pierde soporte en 2026-09    |
|         runtime-eol · esfuerzo medio · confianza alta          [ v ] |
+---------------------------------------------------------------------+
|  Descripcion (markdown)                                             |
|  Recomendacion (markdown, sobre fondo --bg-sunken con borde acento)  |
|                                                                     |
|  Ubicaciones    serverless.yml:14   infra/stack.ts:88               |
|  Referencias    AWS Lambda runtimes  [oficial]                      |
+---------------------------------------------------------------------+
```

  - **Barra de severidad** de 3px en el borde izquierdo, del color semántico. Es lo que permite
    escanear la lista sin leer.
  - **Chip de severidad** en mayúsculas `label`, con su wash de fondo.
  - **Meta**: `category · effort · confidence`, en `caption`.
  - 🟢 **Distintivo de `confidence: low`**: la tarjeta lleva borde punteado, ícono de
    interrogación y el chip *"Confianza baja"* en `--mono-warn`, con tooltip:
    *"El agente no pudo verificar esta afirmación con una fuente oficial."* Es una decisión
    explícita del producto ([09](./09-api-y-ui.md)): no todo se presenta con la misma autoridad.
  - **Ubicaciones**: chips mono `path:line`, clickeables → abren el archivo en GitHub en la
    línea exacta, en el `commit_sha` del run.
  - **Referencias**: links con favicon y badge `oficial` cuando `official: true`.
    🟢 Las URLs no `https://` ya fueron descartadas en el host ([06](./06-agente-mantenimiento.md)),
    así que acá no hay que defenderse de eso.
  - **Acciones por hallazgo** (hover): `Copiar como markdown`, `Crear issue en GitHub` 🟡 v1.1.
  - **Badge `Ya reportado`**: si el `finding_key` existe en un run anterior del mismo repo,
    chip `--text-tertiary` con *"visto en 3 auditorías"* y tooltip con la primera fecha.
    Es el primer valor concreto del `finding_key` estable y no necesita el endpoint de tendencia.

- **Vacío**: 🟢 *"El repositorio está bien mantenido"* con ícono de check grande y una línea
  explicando que es un resultado válido, no un error ([09](./09-api-y-ui.md)). **Nunca** el
  vacío genérico.

#### Tab Traza

- Los 7 pasos, misma anatomía que en vivo pero en reposo: estado final, duración y
  `description` en markdown completo.
- `evidence[]` como lista de chips mono.
- Es la sección que responde *"¿qué hizo realmente el agente?"* ([08](./08-reportes-pdf.md)).
- Al final, bloque colapsado `Log del agente` si existe el artefacto `agent_log`.

#### Tab Limitaciones

- **`limitations[]`**: lista con ícono de círculo abierto. Encabezado honesto:
  *"Qué no se pudo analizar y por qué"*.
- **`out_of_scope_notes[]`**: agrupadas por `area` (security, feature, architecture, other).
  🟢 Las de `security` llevan una nota fija: *"Manteiner no audita seguridad. La auditoría de
  seguridad es un tipo de run aparte, previsto para v2."* ([06](./06-agente-mantenimiento.md)).
- **Disclaimer permanente al pie del informe**, en `caption` sobre `--bg-sunken`:
  *"Informe generado automáticamente con asistencia de IA. Revisalo antes de actuar."*
  🟢 Obligatorio, igual que en el PDF ([08](./08-reportes-pdf.md)).

### V5.2 · Run fallido

Misma ruta, tratamiento distinto. **No** es una pantalla de error genérica.

- Cabecera con ícono de estado `--sev-high` en lugar del score, y el `error_code` traducido a
  lenguaje humano (`CONTAINER_OOM` → *"El contenedor se quedó sin memoria"*).
- `error_message` en un bloque mono colapsable *"Detalle técnico"*.
- **Qué se puede hacer**: lista de 1–3 acciones concretas según el código
  (reintentar, cambiar de modelo, revisar la credencial).
- **Los pasos que sí se completaron se muestran igual**: el trabajo parcial es información.
  El paso donde falló lleva la cruz.
- Botón primario `Volver a auditar`. 🟢 Un run nunca se reanuda: si hay que reintentar, es un run
  nuevo ([01](./01-arquitectura.md)). El copy tiene que decir eso.

---

## V6 · Detalle e histórico del repositorio

**Propósito.** Todo lo de un repo: su configuración y su línea de tiempo.

**Datos.** `GET /api/repos/:id`, `GET /api/repos/:id/runs` (paginado), `PATCH /api/repos/:id`.

**Componentes**

1. **Header**: avatar + `owner/repo` en mono `h1`, chips de lenguaje/rama/visibilidad, link a
   GitHub, botón `Auditar` primario, menú `···` con *Desvincular* (destructivo, con
   confirmación que aclara que **los runs se conservan** — es soft delete,
   [09](./09-api-y-ui.md)).
2. **Tarjeta del último informe**: versión reducida de la cabecera de V5, clickeable.
3. **Preferencia de modelo**: fila con el modelo efectivo y de dónde sale
   (*"Heredado de tu preferencia global"* vs. *"Específico de este repo"*), con `Cambiar`.
4. **Timeline de runs** — lista cronológica descendente:
   - Fila: fecha relativa + absoluta en tooltip, anillo de score mini (28px), `headline`
     truncado, contador de hallazgos, chip de PR, duración, modelo usado.
   - **Delta de score** respecto del run anterior: `+8` en verde / `-5` en rojo, con flecha.
     Detalle barato y de mucho valor.
   - Runs fallidos: fila atenuada con ícono e `error_code`.
   - Paginación por scroll infinito con sentinel; skeleton de 3 filas mientras carga.
5. **Mini gráfico de evolución del `health_score`** — sparkline de 64px sobre el timeline.
   🟡 v1.1 ([09](./09-api-y-ui.md)). Con menos de 3 runs no se dibuja: se muestra
   *"Necesitás al menos 3 auditorías para ver la evolución"*.

**Vacío.** 🟢 Repo sin runs: *"Todavía no auditaste este repositorio"* + descripción de qué va a
pasar + botón. No una tabla vacía.

---

## V7 · Configuración

Layout de dos columnas: navegación de secciones a la izquierda (sticky, 180px) y contenido a la
derecha. Secciones: **Proveedores de IA · Modelo por defecto · GitHub · Cuenta**.

1. **Proveedores de IA** (`GET /api/providers`)
   - Fila por credencial: logo, `label`, `providerId`, `••••lastFour` en mono, chip de estado
     (`active` verde · `invalid` rojo · `revoked` gris), *"verificada hace X"* (`verifiedAt`).
   - Acciones: `Verificar de nuevo`, `Eliminar` (`DELETE`, con confirmación que advierte si hay
     repos usando ese proveedor).
   - 🟢 La key **nunca** se muestra ni se puede revelar: la API no la devuelve
     ([09](./09-api-y-ui.md)). El copy lo dice, así el usuario no la busca.
   - Credencial OAuth de ChatGPT: fila especial con *"Conectado como …"* y estado del token.
     Si expiró: estado rojo + `Reconectar` que abre el device flow en modal (mismo componente
     que V2.1, rama B). 🟢 No hay recuperación automática ([09](./09-api-y-ui.md)).
   - Botón `Agregar proveedor` → mismo flujo que el onboarding, en modal.
2. **Modelo por defecto** (`PUT /api/preferences/model`) — selector de modelo + nota de que cada
   repo puede sobreescribirlo, con link a los que lo hacen.
3. **Catálogo** — *"Actualizado hace 4 horas"* + `Actualizar catálogo`
   (`POST /api/providers/catalog/refresh`), con spinner. Aclarar que levanta un contenedor
   efímero y puede tardar ([04](./04-proveedores-ia-opencode.md)).
4. **GitHub** — instalaciones, cuenta/organización, cantidad de repos accesibles, `Gestionar en
   GitHub`, `Sincronizar ahora`.
5. **Cuenta** — avatar, login, `Cerrar sesión`, y **Borrar cuenta** en una *danger zone* con
   borde `--sev-high` al 30%: enumera exactamente qué se borra (runs, informes, credenciales) y
   exige escribir el `githubLogin` para confirmar.

---

## V8 · Visor de diff

**Datos.** `GET /api/runs/:id/diff` (patch en texto plano).

Panel a pantalla completa (o drawer del 80% desde la derecha, con `Esc` para cerrar).
- Lista de archivos a la izquierda (220px) con `+n / −m` por archivo y filtro.
- Diff unificado a la derecha, mono, resaltado por líneas: `+` fondo verde al 8%,
  `−` fondo rojo al 8%, números de línea en `--text-tertiary` sticky a la izquierda.
- Toggle unificado / lado a lado. Botón `Copiar patch`, botón `Descargar .patch`.
- 🟢 Solo deberían aparecer manifiestos y lockfiles: los demás archivos están denegados a nivel
  de permisos ([06](./06-agente-mantenimiento.md)). Si aparece otro, se marca con advertencia:
  es una anomalía que el usuario querría ver.
- Los lockfiles se colapsan por defecto (son miles de líneas) con *"Mostrar 3.482 líneas"*.

---

## V9 · Vincular repositorios (modal)

Mismo componente que V2.3, en modal de 640px. `GET /api/github/available-repos`.
Buscador con foco automático, lista virtualizada si supera 100 filas, barra inferior con
contador y acción. Al cerrar, las tarjetas nuevas entran en la grilla del dashboard con el
escalonado de entrada.

---

## V10 · Ejecuciones (todas)

Tabla densa de todos los runs del usuario, todos los repos.
Columnas: estado · repo · score · hallazgos · PR · modelo · duración · fecha.
Filtros por repo, estado y rango de fechas. Fila clickeable a V4/V5.
Es la vista "de poder": densidad alta, 40px de alto por fila, sin tarjetas.

---

## V11 · Tendencia de hallazgos — 🟡 v1.1

`GET /api/repos/:id/findings/trend`. Convierte el histórico en algo más que una lista.
- Tres columnas: **Persistentes** · **Resueltos** · **Nuevos**, agrupados por `finding_key`.
- Por hallazgo: sparkline de presencia a lo largo de los runs, primera y última aparición.
- Gráfico de `health_score` a lo largo del tiempo con marcadores en cada run.
- 🟢 Depende de que `finding_key` sea realmente estable: la vista debe manejar el caso de keys
  que cambian de forma (mostrarlos como "nuevo" y no romperse).

---

## V12 · Errores de aplicación

| Caso | Tratamiento |
|---|---|
| **404** | Ilustración mínima, *"Esta página no existe"*, botón al dashboard. |
| **Sesión expirada** | Modal no descartable sobre la vista actual: *"Tu sesión expiró"* + `Iniciar sesión`. No se pierde la ruta: se vuelve a ella tras el login. |
| **API caída** | Banner rojo global, reintento automático con backoff y un contador visible. |
| **Error inesperado** (error boundary) | Tarjeta con el mensaje, botón `Recargar` y `Copiar detalle` para reportar. |

---

## 4. Catálogo de componentes transversales

| Componente | Notas de diseño |
|---|---|
| `Button` | Variantes: primary (acento), secondary (borde `--border-soft`), ghost, danger. Tamaños 32/36/44. Estado `loading` con spinner **sin cambiar el ancho** (evita el salto de layout). |
| `Chip / Badge` | 22px de alto, radio 6, `label`. Variantes: neutral, acento, y una por color semántico con su wash. |
| `StatusDot` | 6–8px. Variantes: estático, pulsante (running), doble anillo (retrying). |
| `HealthRing` | SVG, tamaños 28/44/72. Dibuja el arco en 900ms. Color por tramo. Siempre con etiqueta textual. |
| `SeverityBar` | Barra apilada horizontal de 4px con las 4 severidades. Tooltip por segmento. |
| `StepItem` | Estados: pending/running/completed/skipped/failed. Línea conectora entre pasos. |
| `FindingCard` | Colapsable. Barra lateral de severidad. Tratamiento especial para `confidence: low`. |
| `MarkdownBlock` | Subconjunto acotado: p, ul/ol, code inline, strong, links. Mismo subconjunto que el PDF ([08](./08-reportes-pdf.md)) para que ambos se vean iguales. |
| `CodeBlock` | `--bg-sunken`, mono, scroll horizontal propio, botón de copiar en hover. |
| `DataTable` | Header `label` sticky, filas de 44px, hover `--bg-raised`, números tabulares, orden por columna. |
| `Tabs` | Indicador deslizante. Contador opcional por tab. |
| `Modal` | 18px de radio, backdrop `rgba(0,0,0,.6)` + `blur(8px)`, entrada `scale .97→1` + fade, 260ms. `Esc` cierra, foco atrapado. |
| `Drawer` | Desde la derecha, 80% o 480px. Mismo tratamiento de foco. |
| `Toast` | Inferior derecha, apilado, 4s, con acción opcional. |
| `Banner` | Ancho completo bajo el topbar, persistente, con acción. |
| `EmptyState` | Ícono 40px en círculo `--bg-raised`, título `h2`, una línea `body-sm`, una acción. Nunca más de una acción. |
| `Skeleton` | Bloques `--bg-raised` con shimmer diagonal de 1.6s. Respetan la forma real del contenido. |
| `Tooltip` | 240ms de delay, `--bg-overlay`, `caption`, flecha de 6px. |
| `CopyButton` | Morph a check por 1.2s. Usado en device code, paths, patch, markdown de hallazgos. |
| `Timer` | Mono tabular, `mm:ss` bajo una hora, `h:mm:ss` arriba. Actualiza cada segundo en el cliente. |
| `RelativeTime` | *"hace 3 días"* con la fecha absoluta en `title`. Se recalcula cada 60s. |

---

## 5. Estados vacíos y de error — mapa completo

De [09](./09-api-y-ui.md), con su tratamiento visual:

| Situación | Vista | Tratamiento |
|---|---|---|
| Sin repos vinculados | V3 | Onboarding embebido, no tabla vacía |
| Repo sin runs | V6 | *"Todavía no auditaste este repo"* + botón |
| Run fallido | V5.2 | Código traducido + qué hacer + reintento (run nuevo) |
| Credencial inválida | Global | Banner persistente con link a Configuración |
| Refresh token OAuth vencido | Global + V7 | *"Tu conexión con ChatGPT expiró"* + device flow. Sin recuperación automática |
| Instalación revocada | V3 (tarjeta) + V6 | Banner en el repo afectado + `Reconectar` |
| Run sin hallazgos | V5 | 🟢 *"El repositorio está bien mantenido"* — resultado válido, no vacío |
| Sin PR (no hubo diff) | V5 | *"No se aplicaron cambios"* + motivo, en lugar del botón de PR |
| PDF no generado | V5 | Botón `Regenerar PDF` con advertencia; el run sigue `completed` |
| Cola llena | V4 | *"En cola — N auditorías por delante"* |
| Catálogo de modelos vacío | V2.1/V7 | *"No pudimos leer el catálogo"* + `Reintentar` |

---

## 6. Accesibilidad

- Contraste: texto principal ≥ 7:1, secundario ≥ 4.5:1, chips y bordes ≥ 3:1. **El color nunca
  es el único portador de información**: severidad y estado siempre llevan ícono y/o texto.
- Foco visible en todo: anillo de 2px `--accent` con 2px de offset. Nunca `outline: none` sin
  reemplazo.
- La lista de pasos es una `<ol>` con `aria-live="polite"` en el paso activo, para que un lector
  de pantalla anuncie el avance sin leer todo de nuevo.
- Los contadores en vivo usan `aria-live="polite"`; la línea de herramienta, `aria-live="off"`
  (cambia demasiado rápido y sería insoportable).
- Modales con foco atrapado, `Esc` para cerrar y retorno del foco al disparador.
- Navegación completa por teclado. Atajos: `⌘K` buscar, `G+R` repos, `G+S` settings,
  `[` colapsar sidebar, `?` ayuda de atajos.
- `prefers-reduced-motion` respetado en todo el sistema de motion (§1.5).
- Zoom al 200% sin pérdida de funcionalidad.

---

## 7. Responsive

| Breakpoint | Comportamiento |
|---|---|
| `≥1440` | Sidebar + contenido 1180px + panel lateral del run |
| `1100–1439` | Igual, contenido fluido |
| `900–1099` | Panel del run pasa arriba en horizontal; grilla de repos a 2 columnas |
| `768–899` | Sidebar colapsa a íconos; grilla a 1 columna |
| `<768` | Sidebar en drawer; tarjetas en modo lista; tabs del informe con scroll horizontal; barra de acciones del informe fija abajo |

El objetivo en móvil no es paridad total: es **mirar un run en vivo y leer el informe**. Disparar
auditorías y configurar proveedores son tareas de escritorio.

---

## 8. Mapa de navegación

```
/login
  └─ (OAuth GitHub) ──> /onboarding  (si falta algo de onboarding)
                          └─ paso 1 proveedor · paso 2 GitHub App · paso 3 repos
                                └──> /

/                      V3  Dashboard de repositorios
  ├─ modal vincular    V9
  ├─ /repos/:id        V6  Detalle e histórico
  │    └─ /repos/:id/trend   V11 (v1.1)
  ├─ /runs/:id         V4 en vivo  ──(run.completed)──>  V5 informe   [sin cambio de ruta]
  │    └─ /runs/:id/diff     V8
  └─ /runs             V10 Todas las ejecuciones

/settings              V7  Configuración
```

---

## 9. Orden de maquetado

1. **V3 Dashboard** — define tarjeta, chips, anillo de score, shell.
2. **V4 Run en vivo** — define pasos, estados en vivo, panel de contexto.
3. **V5 Informe** — define tabs, hallazgos, tablas, markdown.
4. **V1 Login** + **V2 Onboarding** — definen el flujo de entrada y el device flow.
5. Secundarias: V6, V7, V8, V9, V10.
6. v1.1: V11.

Las cuatro primeras cubren el 90% del sistema de diseño: el resto es recombinación.

---

## 10. Maquetas

Las vistas principales están maquetadas en un proyecto de Claude Design, con el sistema de
diseño de §1 implementado en un `tokens.css` compartido:

| Archivo | Vista | Qué define |
|---|---|---|
| `tokens.css` | — | Tokens, tipografía, botones, chips, tarjetas, pasos, tablas, hallazgos, motion |
| `01 Dashboard` | V3 | Tarjeta de repo en sus 5 estados, anillo de score, métricas, hero del run activo |
| `02 Run en vivo` | V4 | Los 7 pasos, línea de herramienta, panel de razonamiento, panel de contexto |
| `03 Informe - Resumen` | V5.1 | Cabecera del informe, tabs, overview, stack, tablas de dependencias |
| `04 Informe - Hallazgos` | V5.1 | Filtros, tarjeta de hallazgo expandida y colapsada, distintivo de confianza baja |
| `05 Login` | V1 | Entrada, nota de permisos |
| `06 Onboarding - Proveedor` | V2.1 | Stepper, selección de proveedor, device flow de ChatGPT |

Pendientes de maquetar: V6, V7, V8, V9, V10 (secundarias) y V11 (v1.1).

### Cambios respecto de la propuesta original, decididos al maquetar

- **Tipografía de interfaz**: Instrument Sans en vez de Inter (§1.2).
- **Grilla del dashboard**: hero a ancho completo + 2 columnas en vez de 3 (V3).
- **Callout de recomendación**: sin barra de acento a la izquierda. Con la barra de severidad
  del hallazgo ya había dos elementos compitiendo por el acento dentro de la misma tarjeta, y
  el principio §0.3 dice que solo puede haber uno.
- **Lista de pasos**: línea de tiempo con conector vertical, sin separadores horizontales.
  Tener los dos hacía ruido.

### Revisión 2 de color (tras ver las maquetas)

La primera paleta era correcta en estructura y equivocada en intensidad. Lo que se corrigió:

- **Toda la paleta bajó a ~35% de saturación** y el acento pasó de violeta brillante a indigo
  apagado. Ver §1.1.
- **Se eliminaron glows y gradientes brillantes**: el botón primario no tiene halo ni brillo
  interno, el logotipo es plano, la barra de progreso no emite luz, los fondos ambientales
  bajaron a 3.5% de opacidad.
- **Menos hues por vista.** En el dashboard: el chip del PR dejó de ser verde (un PR abierto no
  es un "éxito", es un hecho), el delta de salud dejó de ser un chip verde, los contadores de
  severidad pasaron de chips rellenos a punto + texto, y los puntos de lenguaje se apagaron.
- **Las cifras grandes son neutras.** Health score y KPI del informe en `--text-primary`.
- **La barra de severidad es un indicador compacto** (`max-width: 132px`). Estirada a todo el
  ancho de una tarjeta, dos hues contiguos se leen como un degradado decorativo.

Regla que quedó de todo esto, y que conviene revisar en cada vista nueva: *si un color ocupa
área, está mal; si un color no significa nada, sobra.*
