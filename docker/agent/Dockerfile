FROM oven/bun:1.3.10-alpine

ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH

RUN mkdir -p /opt/bun \
    && bun add --global opencode-ai@1.18.30 \
    && addgroup -g 10001 opencode \
    && adduser -D -u 10001 -G opencode -h /home/opencode opencode \
    && mkdir -p /home/opencode/.config/opencode /home/opencode/.local/state/opencode \
       /home/opencode/.local/share/opencode /home/opencode/.cache/opencode \
    && chown -R opencode:opencode /home/opencode

# El runner corre con bun, que ejecuta TypeScript directo: no hace falta build.
# No tiene dependencias a proposito, asi que no hay `bun install` que hacer.
COPY --chown=opencode:opencode packages/agent-runner/src/ /opt/runner/

USER 10001:10001
WORKDIR /home/opencode

EXPOSE 4096

# Sin ENTRYPOINT fijo: el contenedor de catalogo corre `opencode serve` pelado y
# el del agente corre el runner. El comando lo elige quien crea el contenedor.
ENTRYPOINT []
