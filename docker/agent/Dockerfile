FROM oven/bun:1.3.10-alpine

ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH

# El agente audita mantenimiento de repositorios: sin git no puede mirar la
# historia ni sacar el diff, y sin un gestor de paquetes no puede consultar el
# estado real de las dependencias, que es el nucleo de la auditoria. Con
# `bash: allow`, un agente sin estas herramientas falla comando por comando.
RUN apk add --no-cache git ca-certificates curl nodejs npm \
    && mkdir -p /opt/bun \
    && bun add --global opencode-ai@1.18.30 \
    && addgroup -g 10001 opencode \
    && adduser -D -u 10001 -G opencode -h /home/opencode opencode \
    && mkdir -p /home/opencode/.config/opencode /home/opencode/.local/state/opencode \
       /home/opencode/.local/share/opencode /home/opencode/.cache/opencode \
    && chown -R opencode:opencode /home/opencode

# git se niega a operar sobre un repo cuyo dueño no es el usuario actual. El
# volumen viene del contenedor de clonado, asi que hay que declararlo seguro.
RUN git config --system --add safe.directory /work/repo

# El runner corre con bun, que ejecuta TypeScript directo: no hace falta build.
# No tiene dependencias a proposito, asi que no hay `bun install` que hacer.
COPY --chown=opencode:opencode packages/agent-runner/src/ /opt/runner/

USER 10001:10001
WORKDIR /home/opencode

EXPOSE 4096

# Sin ENTRYPOINT fijo: el contenedor de catalogo corre `opencode serve` pelado y
# el del agente corre el runner. El comando lo elige quien crea el contenedor.
ENTRYPOINT []
