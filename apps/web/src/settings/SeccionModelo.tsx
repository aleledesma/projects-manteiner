import { useEffect, useState } from "react";

import {
  api,
  ApiError,
  type Catalog,
  type ModelPreference,
  type ProviderCredential,
} from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { InfoIcon } from "../components/icons.tsx";
import { ModelPicker } from "../providers/ModelPicker.tsx";
import { relativo } from "../tiempo.ts";
import { Seccion } from "./Seccion.tsx";

type Props = {
  credenciales: ProviderCredential[];
};

export function SeccionModelo({ credenciales }: Props) {
  const activas = credenciales.filter((c) => c.status === "active");
  const [preferencia, setPreferencia] = useState<ModelPreference | null>(null);
  const [proveedor, setProveedor] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<ModelPreference | null>("/api/preferences/model")
      .then((guardada) => {
        setPreferencia(guardada);
        setProveedor((previo) => previo ?? guardada?.providerId ?? null);
      })
      .catch(() => {});
  }, []);

  const elegido = proveedor ?? activas[0]?.providerId ?? null;

  return (
    <Seccion
      id="modelo"
      titulo="Modelo por defecto"
      bajada="El que usa el agente cuando un repositorio no define el suyo. Cada repositorio puede sobrescribirlo."
    >
      {activas.length === 0 ? (
        <Alert tone="info">
          Conectá un proveedor para poder elegir modelo.
        </Alert>
      ) : (
        <>
          {activas.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {activas.map((credencial) => {
                const on = credencial.providerId === elegido;
                return (
                  <button
                    key={credencial.id}
                    type="button"
                    onClick={() => setProveedor(credencial.providerId)}
                    className={`h-[30px] rounded-lg border px-3 font-mono text-[12.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                      on
                        ? "border-accent/32 bg-accent/8 text-ink"
                        : "border-white/6 bg-surface text-ink-muted hover:border-white/18 hover:bg-raised"
                    }`}
                  >
                    {credencial.providerId}
                  </button>
                );
              })}
            </div>
          ) : null}

          {elegido ? (
            <ModelPicker
              providerId={elegido}
              guardada={preferencia}
              onGuardada={setPreferencia}
            />
          ) : null}
        </>
      )}

      <Catalogo />
    </Seccion>
  );
}

/**
 * Estado del catálogo de modelos. Refrescarlo levanta un contenedor efímero de
 * opencode, así que puede tardar y hay que decirlo antes de que el usuario crea
 * que se colgó.
 */
function Catalogo() {
  const [refrescadoEn, setRefrescadoEn] = useState<number | null>(null);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<Catalog>("/api/providers/catalog")
      .then((catalogo) => setRefrescadoEn(catalogo.refreshedAt))
      .catch(() => {});
  }, []);

  async function refrescar() {
    setRefrescando(true);
    setError(null);
    try {
      const catalogo = await api.post<Catalog>("/api/providers/catalog/refresh", {});
      setRefrescadoEn(catalogo.refreshedAt);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "No se pudo actualizar el catálogo.",
      );
    } finally {
      setRefrescando(false);
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-white/6 bg-surface px-[15px] py-3.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">Catálogo de modelos</p>
          <p className="mt-0.5 text-[12.5px] text-ink-faint">
            {refrescadoEn === null
              ? "Todavía no se descargó."
              : `Actualizado ${relativo(refrescadoEn)}.`}
          </p>
        </div>
        <Button size="sm" loading={refrescando} onClick={() => void refrescar()}>
          {refrescando ? "Actualizando…" : "Actualizar"}
        </Button>
      </div>

      <div className="mt-3 flex gap-2.5 border-t border-white/6 pt-3">
        <InfoIcon className="mt-px size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[60ch] text-xs/[18px] text-ink-faint">
          Actualizar levanta un contenedor efímero de opencode y le pregunta qué modelos hay. Puede
          tardar varios segundos. Se refresca solo una vez por día.
        </p>
      </div>

      {error ? <Alert className="mt-3">{error}</Alert> : null}
    </div>
  );
}
