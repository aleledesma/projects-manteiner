import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  ApiError,
  type Catalog,
  type CatalogModel,
  type ModelPreference,
} from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { CheckIcon, InfoIcon, SearchIcon, Spinner } from "../components/icons.tsx";

type Props = {
  providerId: string;
  /** La preferencia ya guardada, si la había. */
  guardada: ModelPreference | null;
  onGuardada: (preferencia: ModelPreference) => void;
};

type Carga =
  | { estado: "cargando" }
  | { estado: "listo"; modelos: CatalogModel[] }
  | { estado: "error"; mensaje: string };

/**
 * Selector de modelo. La lista sale de `config.providers()` ya autenticado, así
 * que es más corta que el catálogo público del proveedor: la API descarta los
 * modelos sin tool calling, que el agente necesita.
 */
export function ModelPicker({ providerId, guardada, onGuardada }: Props) {
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [filtro, setFiltro] = useState("");
  // Solo la elección local del usuario. Lo ya guardado se deriva de la prop,
  // que puede llegar después del montaje: con useState quedaría congelada en null.
  const [elegidoLocal, setElegidoLocal] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardadoAqui = guardada?.providerId === providerId ? guardada.modelId : null;
  const elegido = elegidoLocal ?? guardadoAqui;

  const cargar = useCallback(async (forzarRefresco: boolean) => {
    setCarga({ estado: "cargando" });
    try {
      // Cache primero. Refrescar levanta un contenedor efímero de opencode, así
      // que solo se hace si el usuario lo pide o si el proveedor no está en la
      // caché todavía (credencial recién conectada).
      let catalogo = forzarRefresco
        ? await api.post<Catalog>("/api/providers/catalog/refresh", { providerId })
        : await api.get<Catalog>("/api/providers/catalog");

      let proveedor = catalogo.providers.find((p) => p.id === providerId);
      if (!forzarRefresco && (proveedor?.models.length ?? 0) === 0) {
        catalogo = await api.post<Catalog>("/api/providers/catalog/refresh", { providerId });
        proveedor = catalogo.providers.find((p) => p.id === providerId);
      }
      setCarga({ estado: "listo", modelos: proveedor?.models ?? [] });
    } catch (cause) {
      setCarga({
        estado: "error",
        mensaje:
          cause instanceof ApiError ? cause.message : "No se pudo leer el catálogo de modelos.",
      });
    }
  }, [providerId]);

  useEffect(() => {
    setElegidoLocal(null);
    void cargar(false);
  }, [cargar]);

  const modelos = carga.estado === "listo" ? carga.modelos : [];
  const filtrados = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return modelos;
    return modelos.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [modelos, filtro]);

  // Con suscripción el catálogo devuelve cost: 0. Mostrar "$0" sería mentir.
  const muestraCosto = modelos.some((m) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0) > 0);

  async function guardar() {
    if (!elegido) return;
    setGuardando(true);
    setError(null);
    try {
      onGuardada(
        await api.put<ModelPreference>("/api/preferences/model", {
          providerId,
          modelId: elegido,
        }),
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "No se pudo guardar el modelo.");
    } finally {
      setGuardando(false);
    }
  }

  if (carga.estado === "cargando") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-white/6 bg-surface px-4 py-3.5 text-[13px] text-ink-muted">
        <Spinner className="size-4" />
        Leyendo los modelos disponibles…
      </div>
    );
  }

  if (carga.estado === "error") {
    return <Alert>{carga.mensaje}</Alert>;
  }

  if (modelos.length === 0) {
    return (
      <Alert tone="warn">
        El proveedor no expone modelos con tool calling, que el agente necesita para trabajar.
      </Alert>
    );
  }

  const yaGuardado = guardada?.providerId === providerId && guardada.modelId === elegido;

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        <label className="flex h-[34px] flex-1 items-center gap-2 rounded-[10px] border border-white/6 bg-sunken px-3">
          <SearchIcon className="size-3.5 shrink-0 text-ink-faint" />
          <input
            type="search"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Filtrar modelos"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-faint"
          />
        </label>
        <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">
          {filtrados.length}/{modelos.length}
        </span>
        <Button
          size="sm"
          className="shrink-0"
          title="Vuelve a preguntarle al proveedor. Levanta un contenedor y tarda unos segundos."
          onClick={() => void cargar(true)}
        >
          Actualizar lista
        </Button>
      </div>

      <div className="max-h-[286px] overflow-y-auto rounded-xl border border-white/6 bg-surface">
        {filtrados.map((modelo) => {
          const on = modelo.id === elegido;
          return (
            <button
              key={modelo.id}
              type="button"
              aria-pressed={on}
              onClick={() => setElegidoLocal(modelo.id)}
              className={`flex w-full items-center gap-3 border-b border-white/4 px-3.5 py-2.5 text-left transition-colors duration-150 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                on ? "bg-accent/8" : "hover:bg-raised"
              }`}
            >
              <span
                className={`grid size-[15px] shrink-0 place-items-center rounded-full border ${
                  on ? "border-accent" : "border-white/18"
                }`}
              >
                {on ? <span className="size-[7px] rounded-full bg-accent" /> : null}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{modelo.name}</span>
                  {modelo.id === guardadoAqui ? <Chip tone="ok">Actual</Chip> : null}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ink-faint">
                  {modelo.id}
                </span>
              </span>

              {modelo.limit?.context ? (
                <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">
                  {formatearContexto(modelo.limit.context)}
                </span>
              ) : null}

              {muestraCosto ? (
                <span
                  title="Costo por millón de tokens (entrada / salida)"
                  className="w-[92px] shrink-0 text-right font-mono text-[11.5px] text-ink-faint tabular-nums"
                >
                  {formatearCosto(modelo)}
                </span>
              ) : null}

              <Chip>tool calling</Chip>
            </button>
          );
        })}
        {filtrados.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[13px] text-ink-faint">
            Ningún modelo coincide con “{filtro}”.
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex gap-2.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[62ch] text-xs/[18px] text-ink-faint">
          La lista puede ser más corta que el catálogo público del proveedor: sale de tu credencial
          ya autenticada y solo incluye modelos con tool calling, que el agente necesita.
          {muestraCosto ? null : " Con suscripción el proveedor no informa costos, así que no se muestran."}
        </p>
      </div>

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <Button
        variant={yaGuardado ? "secondary" : "primary"}
        className="mt-3.5"
        disabled={!elegido || yaGuardado}
        loading={guardando}
        icon={yaGuardado ? <CheckIcon className="size-3.5 text-ok" /> : undefined}
        onClick={() => void guardar()}
      >
        {yaGuardado ? "Modelo guardado" : "Usar este modelo"}
      </Button>
    </div>
  );
}

function formatearContexto(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Costo por millón de tokens, entrada/salida. */
function formatearCosto(modelo: CatalogModel): string {
  if (!modelo.cost) return "—";
  const precio = (valor: number) => (valor >= 10 ? valor.toFixed(0) : valor.toFixed(2));
  return `$${precio(modelo.cost.input)}/$${precio(modelo.cost.output)}`;
}
