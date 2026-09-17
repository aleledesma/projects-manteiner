import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type OAuthStart, type OAuthStatus } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { CheckIcon, CopyIcon, ExternalIcon, InfoIcon, Spinner } from "../components/icons.tsx";

const POLL_MS = 2_000;

/** El poll token vive en sessionStorage: si el usuario recarga, el flujo sigue. */
const STORAGE_KEY = "manteiner:openai-device-flow";

type Props = {
  /** Llamado cuando la credencial ya quedó guardada en el servidor. */
  onAuthorized: () => void;
};

type Flow = { url: string; userCode: string; pollToken: string; expiresAt: number };

function leerFlujoGuardado(): Flow | null {
  try {
    const crudo = sessionStorage.getItem(STORAGE_KEY);
    if (!crudo) return null;
    const flujo = JSON.parse(crudo) as Flow;
    if (typeof flujo?.pollToken !== "string" || flujo.expiresAt <= Date.now()) return null;
    return flujo;
  } catch {
    return null;
  }
}

function guardarFlujo(flujo: Flow | null): void {
  try {
    if (flujo) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(flujo));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Modo privado o storage bloqueado: el flujo sigue funcionando en memoria.
  }
}

export function DeviceFlow({ onAuthorized }: Props) {
  const [flujo, setFlujo] = useState<Flow | null>(leerFlujoGuardado);
  const [estado, setEstado] = useState<OAuthStatus["status"] | "iniciando">(
    flujo ? "pending" : "iniciando",
  );
  const [error, setError] = useState<string | null>(null);
  const [restante, setRestante] = useState(() => (flujo ? flujo.expiresAt - Date.now() : 0));
  const [copiado, setCopiado] = useState(false);

  // El callback se guarda en un ref: si entrara como dependencia del efecto de
  // polling, cada render del padre reiniciaría el intervalo.
  const alAutorizar = useRef(onAuthorized);
  useEffect(() => {
    alAutorizar.current = onAuthorized;
  });

  const iniciar = useCallback(async () => {
    setEstado("iniciando");
    setError(null);
    try {
      const inicio = await api.post<OAuthStart>("/api/providers/oauth/openai/start");
      const nuevo: Flow = {
        url: inicio.url,
        userCode: inicio.userCode,
        pollToken: inicio.pollToken,
        expiresAt: Date.now() + inicio.expiresIn * 1_000,
      };
      guardarFlujo(nuevo);
      setFlujo(nuevo);
      setRestante(nuevo.expiresAt - Date.now());
      setEstado("pending");
    } catch (cause) {
      setEstado("failed");
      setError(
        cause instanceof ApiError
          ? cause.message
          : "No se pudo iniciar la autorización con OpenAI.",
      );
    }
  }, []);

  // Arranque: si no hay flujo rehidratado, se pide uno.
  useEffect(() => {
    if (!flujo) void iniciar();
    // Intencionalmente solo al montar: reintentar es explícito, con el botón.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling del estado. El polling contra OpenAI lo hace el backend; acá solo
  // se consulta el resultado, así que cerrar la pestaña no cancela nada.
  useEffect(() => {
    if (!flujo || estado !== "pending") return;
    let vivo = true;

    async function consultar() {
      try {
        const resultado = await api.get<OAuthStatus>(
          `/api/providers/oauth/openai/status?pollToken=${encodeURIComponent(flujo!.pollToken)}`,
        );
        if (!vivo) return;
        if (resultado.status === "authorized") {
          setEstado("authorized");
          guardarFlujo(null);
          return;
        }
        if (resultado.status === "expired" || resultado.status === "failed") {
          setEstado(resultado.status);
          guardarFlujo(null);
          if (resultado.errorCode) setError(traducirError(resultado.errorCode));
        }
      } catch (cause) {
        if (!vivo) return;
        // El flujo se perdió del servidor (reinicio de la API): hay que rehacerlo.
        if (cause instanceof ApiError && cause.status === 404) {
          setEstado("expired");
          guardarFlujo(null);
        }
      }
    }

    const id = setInterval(() => void consultar(), POLL_MS);
    void consultar();
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [flujo, estado]);

  // El aviso al padre vive en su propio efecto: si colgara del efecto de polling,
  // el cambio a "authorized" dispararía su cleanup y cancelaría este timeout.
  useEffect(() => {
    if (estado !== "authorized") return;
    // 900ms para que se vea el estado de éxito antes de avanzar.
    const id = setTimeout(() => alAutorizar.current(), 900);
    return () => clearTimeout(id);
  }, [estado]);

  // Cuenta regresiva. Es independiente del polling para que el número no salte.
  useEffect(() => {
    if (!flujo || estado !== "pending") return;
    const id = setInterval(() => {
      const queda = flujo.expiresAt - Date.now();
      setRestante(queda);
      if (queda <= 0) setEstado("expired");
    }, 1_000);
    return () => clearInterval(id);
  }, [flujo, estado]);

  async function copiar() {
    if (!flujo) return;
    try {
      await navigator.clipboard.writeText(flujo.userCode);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1_200);
    } catch {
      setError("No se pudo copiar. Escribí el código a mano.");
    }
  }

  if (estado === "iniciando") {
    return (
      <div className="mt-3 flex items-center gap-2.5 rounded-[13px] border border-white/6 bg-surface px-[18px] py-4 text-[13px] text-ink-muted">
        <Spinner className="size-4" />
        Pidiendo un código a OpenAI…
      </div>
    );
  }

  if (estado === "failed" || (!flujo && estado !== "authorized")) {
    return (
      <div className="mt-3">
        <Alert>{error ?? "No se pudo iniciar la autorización con OpenAI."}</Alert>
        <Button className="mt-3" onClick={() => void iniciar()}>
          Reintentar
        </Button>
      </div>
    );
  }

  if (estado === "authorized") {
    return (
      <div className="animate-pop mt-3 flex items-center gap-3 rounded-[13px] border border-ok/26 bg-ok/8 px-[18px] py-4">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok/16">
          <CheckIcon className="size-3.5 text-ok" />
        </span>
        <span className="text-[13.5px] font-medium text-ok">Cuenta de OpenAI conectada.</span>
      </div>
    );
  }

  const expirado = estado === "expired";
  const segundos = Math.max(0, Math.floor(restante / 1_000));
  const tonoContador =
    segundos < 30 ? "text-sev-high" : segundos < 120 ? "text-sev-medium" : "text-ink-faint";

  return (
    <div>
      <div className="mt-3 overflow-hidden rounded-[13px] border border-accent/26 bg-surface">
        <div className="grid grid-cols-[20px_1fr] gap-x-[13px] px-[18px] py-4">
          <StepNumber>1</StepNumber>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Abrí este enlace en otra pestaña</p>
            <div className="mt-2.5 flex h-[38px] items-center gap-2.5 rounded-[10px] border border-white/6 bg-sunken pr-1 pl-3">
              <span className="truncate font-mono text-[12.5px] text-ink-muted">{flujo!.url}</span>
              <Button
                size="sm"
                className="ml-auto shrink-0"
                icon={<ExternalIcon className="size-3.5" />}
                onClick={() => window.open(flujo!.url, "_blank", "noopener,noreferrer")}
              >
                Abrir
              </Button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-[20px_1fr] gap-x-[13px] border-t border-white/6 px-[18px] py-4">
          <StepNumber>2</StepNumber>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Ingresá este código</p>
            <div className="mt-[11px] flex items-center gap-3.5 rounded-xl border border-dashed border-white/16 bg-sunken px-[18px] py-4">
              <span
                className={`font-mono text-[32px] font-medium tracking-[0.14em] max-sm:text-[25px] ${
                  expirado ? "text-ink-faint line-through" : ""
                }`}
              >
                {flujo!.userCode}
              </span>
              {expirado ? null : (
                <Button
                  size="sm"
                  className="ml-auto shrink-0"
                  icon={copiado ? <CheckIcon className="size-3.5 text-ok" /> : <CopyIcon className="size-3" />}
                  onClick={() => void copiar()}
                >
                  {copiado ? "Copiado" : "Copiar"}
                </Button>
              )}
            </div>
          </div>
        </div>

        {expirado ? (
          <div className="flex items-center gap-2.5 border-t border-white/6 bg-sev-medium/5 px-[18px] py-3.5">
            <span className="text-[13px] text-[#d8b47f]">El código venció.</span>
            <Button size="sm" className="ml-auto" onClick={() => void iniciar()}>
              Generar código nuevo
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 border-t border-white/6 bg-accent/4 px-[18px] py-3.5">
            <span className="relative grid size-2 place-items-center">
              <span className="absolute size-2 animate-ping rounded-full bg-accent/60" />
              <span className="size-2 rounded-full bg-accent" />
            </span>
            <span className="text-[13px] text-accent-text">Esperando autorización…</span>
            <span className={`ml-auto font-mono text-[12.5px] tabular-nums ${tonoContador}`}>
              expira en {formatearCuenta(segundos)}
            </span>
          </div>
        )}
      </div>

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <div className="mt-3.5 flex gap-2.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[60ch] text-xs/[18px] text-ink-faint">
          Podés cerrar esta pestaña: la espera la hace el servidor, no el navegador. Cuando vuelvas,
          el estado va a estar actualizado.
        </p>
      </div>
    </div>
  );
}

function StepNumber({ children }: { children: string }) {
  return (
    <span className="mt-px grid size-5 place-items-center rounded-full border border-white/6 bg-raised font-mono text-[10.5px] text-ink-muted">
      {children}
    </span>
  );
}

function formatearCuenta(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function traducirError(code: string): string {
  if (code === "access_denied") return "Rechazaste la autorización en OpenAI.";
  if (code === "expired_token") return "El código venció antes de que lo ingresaras.";
  return `OpenAI rechazó la autorización (${code}).`;
}
