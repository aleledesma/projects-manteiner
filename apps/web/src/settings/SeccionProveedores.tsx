import { useState } from "react";

import { api, ApiError, type ProviderCredential } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { Modal } from "../components/Modal.tsx";
import { InfoIcon, LockIcon } from "../components/icons.tsx";
import { ConectarProveedor, traducirErrorCredencial } from "../providers/ConectarProveedor.tsx";
import { DeviceFlow } from "../providers/DeviceFlow.tsx";
import { PROVIDER_OPTIONS, logoFor } from "../providers/catalogo.ts";
import { relativo } from "../tiempo.ts";
import { Seccion } from "./Seccion.tsx";

type Props = {
  credenciales: ProviderCredential[];
  recargar: () => void;
};

const ESTADOS = {
  active: { tono: "ok" as const, texto: "Activa" },
  invalid: { tono: "error" as const, texto: "Inválida" },
  revoked: { tono: "neutral" as const, texto: "Revocada" },
};

export function SeccionProveedores({ credenciales, recargar }: Props) {
  const [agregando, setAgregando] = useState(false);
  const [reconectando, setReconectando] = useState<ProviderCredential | null>(null);
  const [borrando, setBorrando] = useState<ProviderCredential | null>(null);

  return (
    <Seccion
      id="proveedores"
      titulo="Proveedores de IA"
      bajada="El agente corre con tus credenciales. Manteiner nunca provee el modelo."
      accion={
        <Button size="sm" onClick={() => setAgregando(true)}>
          Agregar proveedor
        </Button>
      }
    >
      {credenciales.length === 0 ? (
        <div className="rounded-xl border border-white/6 bg-surface px-[18px] py-7 text-center">
          <p className="text-[13.5px] font-medium">No tenés ningún proveedor conectado</p>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] text-ink-muted">
            Sin credencial no se puede disparar ninguna auditoría.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/6 bg-surface">
          {credenciales.map((credencial) => (
            <Fila
              key={credencial.id}
              credencial={credencial}
              onReconectar={() => setReconectando(credencial)}
              onEliminar={() => setBorrando(credencial)}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2.5">
        <LockIcon className="mt-px size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[62ch] text-xs/[18px] text-ink-faint">
          Las credenciales se guardan cifradas y la API nunca las devuelve, ni siquiera a vos. Si
          perdiste una key, generá otra en el proveedor y reemplazá la credencial acá.
        </p>
      </div>

      {agregando ? (
        <Modal
          titulo="Agregar proveedor"
          descripcion="Podés tener varias credenciales. La que se use depende del modelo elegido."
          ancho="lg"
          onCerrar={() => setAgregando(false)}
        >
          <ConectarProveedor
            onConectado={() => {
              setAgregando(false);
              recargar();
            }}
          />
        </Modal>
      ) : null}

      {reconectando ? (
        <Modal
          titulo="Reconectar con OpenAI"
          descripcion="La conexión de una suscripción no se recupera sola: hay que volver a autorizar."
          onCerrar={() => setReconectando(null)}
        >
          <DeviceFlow
            onAuthorized={() => {
              setReconectando(null);
              recargar();
            }}
          />
        </Modal>
      ) : null}

      {borrando ? (
        <ConfirmarBorrado
          credencial={borrando}
          onCerrar={() => setBorrando(null)}
          onBorrada={() => {
            setBorrando(null);
            recargar();
          }}
        />
      ) : null}
    </Seccion>
  );
}

function Fila({
  credencial,
  onReconectar,
  onEliminar,
}: {
  credencial: ProviderCredential;
  onReconectar: () => void;
  onEliminar: () => void;
}) {
  const estado = ESTADOS[credencial.status];
  const opcion = PROVIDER_OPTIONS.find(
    (o) => o.providerId === credencial.providerId && o.auth === credencial.authType,
  );
  const vencido = credencial.expiresAt !== null && credencial.expiresAt <= Date.now();

  return (
    <div className="flex items-center gap-3 border-b border-white/4 px-[15px] py-3.5 last:border-b-0">
      <span className="grid size-[26px] shrink-0 place-items-center rounded-lg border border-white/6 bg-raised text-[10.5px] font-semibold text-ink-faint">
        {opcion?.logo ?? logoFor(credencial.providerId)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">
            {credencial.label ?? opcion?.title ?? credencial.providerId}
          </span>
          <Chip tone={estado.tono === "error" ? "neutral" : estado.tono}>
            {vencido && credencial.status === "active" ? "Vencida" : estado.texto}
          </Chip>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-faint">
          <span className="font-mono">{credencial.providerId}</span>
          {credencial.lastFour ? (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">••••{credencial.lastFour}</span>
            </>
          ) : null}
          {credencial.authType === "oauth" ? (
            <>
              <span className="opacity-40">·</span>
              <span>suscripción</span>
            </>
          ) : null}
          {credencial.verifiedAt ? (
            <>
              <span className="opacity-40">·</span>
              <span>verificada {relativo(credencial.verifiedAt)}</span>
            </>
          ) : null}
        </div>
      </div>

      {credencial.authType === "oauth" ? (
        <Button size="sm" variant={vencido ? "primary" : "secondary"} onClick={onReconectar}>
          Reconectar
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onEliminar}>
        Eliminar
      </Button>
    </div>
  );
}

function ConfirmarBorrado({
  credencial,
  onCerrar,
  onBorrada,
}: {
  credencial: ProviderCredential;
  onCerrar: () => void;
  onBorrada: () => void;
}) {
  const [borrando, setBorrando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function borrar() {
    setBorrando(true);
    setError(null);
    try {
      await api.delete(`/api/providers/${credencial.id}`);
      onBorrada();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : traducirErrorCredencial(cause));
      setBorrando(false);
    }
  }

  return (
    <Modal
      titulo="Eliminar credencial"
      onCerrar={onCerrar}
      pie={
        <>
          <Button size="sm" variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button size="sm" variant="danger" loading={borrando} onClick={() => void borrar()}>
            Eliminar
          </Button>
        </>
      }
    >
      <p className="text-[13.5px]/[20px]">
        Se va a borrar la credencial de{" "}
        <span className="font-mono">{credencial.providerId}</span>
        {credencial.lastFour ? <span className="font-mono"> (••••{credencial.lastFour})</span> : null}.
      </p>
      <div className="mt-3 flex gap-2.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
        <p className="text-[12.5px]/[18px] text-ink-faint">
          Si tenés el modelo por defecto o algún repositorio apuntando a este proveedor, las
          auditorías van a fallar hasta que elijas otro. La credencial no se puede recuperar:
          habría que volver a conectarla.
        </p>
      </div>
      {error ? <Alert className="mt-3">{error}</Alert> : null}
    </Modal>
  );
}
