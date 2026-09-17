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

USER 10001:10001
WORKDIR /home/opencode

EXPOSE 4096

ENTRYPOINT []
