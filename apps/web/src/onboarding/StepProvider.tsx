import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type ModelPreference, type ProviderCredential } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { ArrowRightIcon, CheckIcon, Spinner } from "../components/icons.tsx";
import { ConectarProveedor } from "../providers/ConectarProveedor.tsx";
import { ModelPicker } from "../providers/ModelPicker.tsx";

type Props = {
  /** Se llama tras conectar o desconectar, para refrescar `/api/me`. */
  onConectado: () => void;
  /** Avanza al paso 2. La elección de modelo no es obligatoria para seguir. */
  onAvanzar: () => void;
};

export function StepProvider({ onConectado, onAvanzar }: Props) {
  const [credenciales, setCredenciales] = useState<ProviderCredential[] | null>(null);
  const [preferencia, setPreferencia] = useState<ModelPreference | null>(null);

  /**
   * Relee las credenciales y avisa al padre. Sin esto el paso quedaba mostrando
   * el selector de proveedor después de conectar, hasta recargar la página.
   */
  const refrescar = useCallback(async () => {
    setCredenciales(await api.get<ProviderCredential[]>("/api/providers").catch(() => []));
    onConectado();
  }, [onConectado]);

  useEffect(() => {
    void api.get<ProviderCredential[]>("/api/providers").then(setCredenciales).catch(() => setCredenciales([]));
    void api.get<ModelPreference | null>("/api/preferences/model").then(setPreferencia).catch(() => {});
  }, []);

  const activa = credenciales?.find((c) => c.status === "active");

  if (credenciales === null) {
    return (
      <div className="flex items-center gap-2.5 py-2 text-[13px] text-ink-muted">
        <Spinner className="size-4" />
        Cargando proveedores…
      </div>
    );
  }

  if (!activa) return <ConectarProveedor onConectado={() => void refrescar()} />;

  // Ya hay credencial: la selección se colapsa y el foco pasa al modelo.
  return (
    <div>
      <CredencialConectada credencial={activa} onDesconectada={() => void refrescar()} />

      <div className="mt-6">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13.5px] font-semibold">Modelo por defecto</h3>
          <span className="text-[11.5px] text-ink-faint">Opcional</span>
        </div>
        <p className="mt-1 mb-3 max-w-[60ch] text-[13px] text-ink-muted">
          El que va a usar el agente salvo que lo cambies para un repositorio puntual. Podés
          elegirlo ahora o más tarde, desde Configuración.
        </p>
        <ModelPicker
          providerId={activa.providerId}
          guardada={preferencia}
          onGuardada={setPreferencia}
        />
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-white/6 pt-5">
        <Button variant="primary" icon={<ArrowRightIcon className="size-4" />} onClick={onAvanzar}>
          Continuar
        </Button>
        <span className="text-[13px] text-ink-muted">
          {preferencia?.providerId === activa.providerId
            ? "Modelo elegido. Seguís con la GitHub App."
            : "Podés seguir sin elegir modelo."}
        </span>
      </div>
    </div>
  );
}

function CredencialConectada({
  credencial,
  onDesconectada,
}: {
  credencial: ProviderCredential;
  onDesconectada: () => void;
}) {
  const [borrando, setBorrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function desconectar() {
    setBorrando(true);
    setError(null);
    try {
      await api.delete(`/api/providers/${credencial.id}`);
      onDesconectada();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "No se pudo desconectar.");
      setBorrando(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 rounded-xl border border-ok/26 bg-ok/8 px-[15px] py-3.5">
        <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-ok/16">
          <CheckIcon className="size-3 text-ok" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold">
            {credencial.label ?? credencial.providerId}
          </span>
          <span className="mt-[3px] block text-[13px] text-ink-muted">
            {credencial.authType === "oauth" ? "Conectado por tu cuenta" : "API key"}
            {credencial.lastFour ? (
              <span className="font-mono"> · ••••{credencial.lastFour}</span>
            ) : null}
          </span>
        </span>
        <Button size="sm" variant="ghost" loading={borrando} onClick={() => void desconectar()}>
          Desconectar
        </Button>
      </div>
      {error ? <Alert className="mt-3">{error}</Alert> : null}
    </div>
  );
}
