import { useEffect, useState } from "react";

import { api, ApiError, type Catalog, type ProviderCredential } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { ExternalIcon, EyeIcon, EyeOffIcon } from "../components/icons.tsx";
import { logoFor, PROVIDER_OPTIONS, type ProviderOption } from "./catalogo.ts";
import { DeviceFlow } from "./DeviceFlow.tsx";

type Props = {
  /** Se llama cuando la credencial ya quedó guardada en el servidor. */
  onConectado: () => void;
  /** Proveedor preseleccionado, por `key` de la lista curada. */
  inicial?: string;
};

/**
 * Elección de proveedor y sus dos ramas de conexión. Lo usan el paso 1 del
 * onboarding y el modal de Configuración: es exactamente el mismo flujo, así
 * que vive acá y no dentro de ninguno de los dos.
 */
export function ConectarProveedor({ onConectado, inicial }: Props) {
  const [elegida, setElegida] = useState<string>(inicial ?? PROVIDER_OPTIONS[0]!.key);
  const [extras, setExtras] = useState<ProviderOption[]>([]);

  useEffect(() => {
    // Proveedores del catálogo que no están en la lista curada. Si el catálogo
    // no está disponible (Docker caído), simplemente no se ofrecen los extras:
    // las opciones principales siguen funcionando.
    let vivo = true;
    api
      .get<Catalog>("/api/providers/catalog")
      .then((catalogo) => {
        if (!vivo) return;
        const curados = new Set(PROVIDER_OPTIONS.map((o) => o.providerId));
        setExtras(
          catalogo.providers
            .filter((p) => !curados.has(p.id) && p.models.length > 0)
            .map((p) => ({
              key: `${p.id}-api`,
              providerId: p.id,
              auth: "api" as const,
              logo: logoFor(p.id),
              title: `${p.name} · API key`,
              description: `${p.models.length} ${p.models.length === 1 ? "modelo" : "modelos"} con tool calling.`,
            })),
        );
      })
      .catch(() => setExtras([]));
    return () => {
      vivo = false;
    };
  }, []);

  const principales = PROVIDER_OPTIONS;
  const opcionElegida = [...principales, ...extras].find((o) => o.key === elegida);

  return (
    <div>
      <TarjetaProveedor
        opcion={principales[0]!}
        seleccionada={elegida === principales[0]!.key}
        onSeleccionar={setElegida}
      />
      {elegida === principales[0]!.key ? <DeviceFlow onAuthorized={onConectado} /> : null}

      <div className="mt-7">
        <p className="mb-2.5 text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
          Otras opciones
        </p>
        {[...principales.slice(1), ...extras].map((opcion) => (
          <div key={opcion.key}>
            <TarjetaProveedor
              opcion={opcion}
              seleccionada={elegida === opcion.key}
              onSeleccionar={setElegida}
            />
            {elegida === opcion.key && opcion.auth === "api" ? (
              <FormularioApiKey opcion={opcion} onGuardada={onConectado} />
            ) : null}
          </div>
        ))}
      </div>

      {opcionElegida?.auth === "oauth" && opcionElegida.soon ? (
        <Alert tone="info" className="mt-3">
          Este proveedor todavía no tiene su flujo de autorización implementado.
        </Alert>
      ) : null}
    </div>
  );
}

function TarjetaProveedor({
  opcion,
  seleccionada,
  onSeleccionar,
}: {
  opcion: ProviderOption;
  seleccionada: boolean;
  onSeleccionar: (key: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={seleccionada}
      disabled={opcion.soon}
      onClick={() => onSeleccionar(opcion.key)}
      className={`mt-2 flex w-full items-start gap-3 rounded-xl border px-[15px] py-3.5 text-left transition-colors duration-150 first:mt-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        opcion.soon
          ? "pointer-events-none border-white/6 bg-surface opacity-[0.42]"
          : seleccionada
            ? "border-accent/32 bg-accent/8"
            : "border-white/6 bg-surface hover:border-white/18 hover:bg-raised"
      }`}
    >
      <span
        className={`mt-[3px] grid size-[15px] shrink-0 place-items-center rounded-full border-[1.5px] ${
          seleccionada ? "border-accent" : "border-white/18"
        }`}
      >
        {seleccionada ? <span className="size-[7px] rounded-full bg-accent" /> : null}
      </span>

      <span className="grid size-[26px] shrink-0 place-items-center rounded-lg border border-white/6 bg-raised text-[10.5px] font-semibold tracking-[0.02em] text-ink-faint">
        {opcion.logo}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold">{opcion.title}</span>
          {opcion.recommended ? <Chip tone="accent">Recomendado</Chip> : null}
          {opcion.soon ? <Chip>Próximamente</Chip> : null}
        </span>
        <span className="mt-[3px] block text-[13px] text-ink-muted">{opcion.description}</span>
      </span>
    </button>
  );
}

function FormularioApiKey({
  opcion,
  onGuardada,
}: {
  opcion: ProviderOption;
  onGuardada: () => void;
}) {
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [validando, setValidando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    if (!key.trim()) return;
    setValidando(true);
    setError(null);
    try {
      await api.post<ProviderCredential>("/api/providers", {
        providerId: opcion.providerId,
        apiKey: key.trim(),
      });
      onGuardada();
    } catch (cause) {
      // El input conserva el valor: puede ser un typo de una key larga.
      setError(traducirErrorCredencial(cause));
    } finally {
      setValidando(false);
    }
  }

  return (
    <div className="mt-3 rounded-[13px] border border-accent/26 bg-surface px-[18px] py-4">
      <label className="block text-[13.5px] font-medium" htmlFor={`key-${opcion.key}`}>
        API key de {opcion.title.split(" · ")[0]}
      </label>

      <div className="mt-2.5 flex h-[38px] items-center gap-1 rounded-[10px] border border-white/6 bg-sunken pr-1 pl-3 focus-within:border-accent/40">
        <input
          id={`key-${opcion.key}`}
          type={visible ? "text" : "password"}
          value={key}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void guardar();
          }}
          placeholder={opcion.keyHint ?? "sk-…"}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Ocultar la key" : "Mostrar la key"}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      </div>

      {opcion.keyUrl ? (
        <a
          href={opcion.keyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-ink-muted"
        >
          Dónde conseguirla
          <ExternalIcon className="size-3" />
        </a>
      ) : null}

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <div className="mt-3.5">
        <Button variant="primary" loading={validando} disabled={!key.trim()} onClick={() => void guardar()}>
          {validando ? "Verificando con el proveedor…" : "Validar y guardar"}
        </Button>
        {validando ? (
          <>
            <div className="mt-3 h-0.5 overflow-hidden rounded-full bg-white/6">
              <div className="h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-accent/70" />
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              Se levanta un contenedor efímero y se le pide un prompt de prueba al proveedor. Puede
              tardar unos segundos.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function traducirErrorCredencial(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "No se pudo guardar la credencial.";
  if (cause.code === "PROVIDER_AUTH_FAILED")
    return "El proveedor rechazó la credencial. Revisá que la key sea correcta y esté activa.";
  if (cause.code === "MODEL_NOT_USABLE")
    return "La credencial es válida pero el proveedor no ofrece modelos con tool calling, que el agente necesita.";
  if (cause.code === "IMAGE_MISSING")
    return "Falta construir la imagen del agente en el servidor (npm run docker:build:agent).";
  if (cause.code === "DOCKER_UNAVAILABLE")
    return "El servidor no puede hablar con Docker, así que no puede verificar la credencial.";
  return cause.message;
}
