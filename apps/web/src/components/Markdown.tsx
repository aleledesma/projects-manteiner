import type { ReactNode } from "react";

/**
 * Renderizador minimo de markdown para el texto que escribe el agente.
 *
 * Construye elementos de React, nunca HTML crudo: el informe viene de un modelo
 * que leyo un repositorio no confiable, asi que `dangerouslySetInnerHTML` seria
 * un XSS de manual. Cubre lo que el prompt pide (parrafos, listas, `codigo`,
 * **negrita**) y lo demas queda como texto plano, que es el fallo correcto.
 */
export function Markdown({ texto, className = "" }: { texto: string; className?: string }) {
  const bloques = texto.trim().split(/\n{2,}/);

  return (
    <div className={`flex flex-col gap-3 text-[13.5px]/[21px] text-ink-muted ${className}`}>
      {bloques.map((bloque, indice) => {
        const lineas = bloque.split("\n");
        const esLista = lineas.every((linea) => /^\s*[-*]\s+/.test(linea));

        if (esLista) {
          return (
            <ul key={indice} className="flex flex-col gap-1.5 pl-1">
              {lineas.map((linea, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-faint" />
                  <span>{inline(linea.replace(/^\s*[-*]\s+/, ""))}</span>
                </li>
              ))}
            </ul>
          );
        }

        return <p key={indice}>{inline(bloque.replace(/\n/g, " "))}</p>;
      })}
    </div>
  );
}

/** `codigo`, **negrita** y el resto como texto. */
function inline(texto: string): ReactNode[] {
  const partes: ReactNode[] = [];
  const patron = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let ultimo = 0;
  let coincidencia: RegExpExecArray | null;

  while ((coincidencia = patron.exec(texto)) !== null) {
    if (coincidencia.index > ultimo) partes.push(texto.slice(ultimo, coincidencia.index));
    if (coincidencia[1] !== undefined) {
      partes.push(
        <code
          key={coincidencia.index}
          className="rounded-[5px] border border-white/6 bg-sunken px-1 py-0.5 font-mono text-[12px] text-ink"
        >
          {coincidencia[1]}
        </code>,
      );
    } else {
      partes.push(
        <strong key={coincidencia.index} className="font-semibold text-ink">
          {coincidencia[2]}
        </strong>,
      );
    }
    ultimo = patron.lastIndex;
  }

  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}
