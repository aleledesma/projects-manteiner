/**
 * Opciones de proveedor del paso 1.
 *
 * Es una lista curada, no el catálogo crudo: el catálogo de opencode trae
 * decenas de proveedores y el usuario está eligiendo con qué credencial va a
 * trabajar, no explorando un índice. Los proveedores del catálogo que no están
 * acá se ofrecen igual, al final, como "otros compatibles".
 *
 * `key` existe porque `openai` aparece dos veces: una por OAuth de suscripción
 * y otra por API key de plataforma. El `providerId` es el mismo.
 */

export type ProviderOption = {
  key: string;
  providerId: string;
  auth: "oauth" | "api";
  logo: string;
  title: string;
  description: string;
  /** Badge en acento. Solo una opción lo lleva. */
  recommended?: boolean;
  /** Visible pero deshabilitado: el flujo todavía no está implementado. */
  soon?: boolean;
  /** Dónde sacar la API key en el proveedor. */
  keyUrl?: string;
  keyHint?: string;
};

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    key: "openai-oauth",
    providerId: "openai",
    auth: "oauth",
    logo: "AI",
    title: "OpenAI · cuenta ChatGPT Plus o Pro",
    description: "Usás tu suscripción. No hace falta API key ni tarjeta.",
    recommended: true,
  },
  {
    key: "openai-api",
    providerId: "openai",
    auth: "api",
    logo: "AI",
    title: "OpenAI · API key de plataforma",
    description: "Se cobra por uso. Se valida contra el proveedor antes de guardarse.",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Empieza con sk-",
  },
  {
    key: "anthropic-api",
    providerId: "anthropic",
    auth: "api",
    logo: "AN",
    title: "Anthropic · API key",
    description: "Se cobra por uso.",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Empieza con sk-ant-",
  },
  {
    key: "openrouter-api",
    providerId: "openrouter",
    auth: "api",
    logo: "OR",
    title: "OpenRouter · API key",
    description: "Acceso a varios proveedores con una sola credencial.",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "Empieza con sk-or-",
  },
  {
    key: "claude-oauth",
    providerId: "anthropic",
    auth: "oauth",
    logo: "CL",
    title: "Claude Pro o Max",
    description: "Requiere replicar su flujo de autorización. Todavía no está implementado.",
    soon: true,
  },
  {
    key: "copilot-oauth",
    providerId: "github-copilot",
    auth: "oauth",
    logo: "CP",
    title: "GitHub Copilot",
    description: "Requiere replicar su flujo de autorización. Todavía no está implementado.",
    soon: true,
  },
];

/** Iniciales para el logo de un proveedor que viene del catálogo y no está curado. */
export function logoFor(providerId: string): string {
  const letras = providerId.replace(/[^a-z0-9]/gi, "");
  return (letras.slice(0, 2) || "??").toUpperCase();
}
