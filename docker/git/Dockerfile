# syntax=docker/dockerfile:1

FROM alpine:3.22.1

RUN apk add --no-cache ca-certificates git \
    && addgroup -S -g 10001 manteiner \
    && adduser -S -D -u 10001 -G manteiner manteiner \
    && install -d -m 0700 -o manteiner -g manteiner /work \
    && touch /work/.volume-init \
    && chown manteiner:manteiner /work/.volume-init

COPY --chown=manteiner:manteiner --chmod=0555 clone.sh /usr/local/bin/clone.sh

USER 10001:10001
WORKDIR /work
