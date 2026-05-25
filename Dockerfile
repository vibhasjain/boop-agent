FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build whisper.cpp in a separate stage so the runtime image only carries
# the binary + model, not the toolchain.
FROM debian:bookworm-slim AS whisper-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch v1.7.4 https://github.com/ggerganov/whisper.cpp.git
WORKDIR /build/whisper.cpp
# CPU-only build. Produces ./build/bin/whisper-cli (renamed from main in
# recent versions). No GPU flags — Fly shared-cpu-1x has no GPU anyway.
RUN cmake -B build -DGGML_NATIVE=OFF -DGGML_CUDA=OFF && \
    cmake --build build --config Release -j --target whisper-cli
# Download the tiny.en model (~75MB). English-only, fast, fine for short
# voice memos by a single speaker.
RUN ./models/download-ggml-model.sh tiny.en

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runner
ENV NODE_ENV=production
# ffmpeg converts Sendblue's .caf / .m4a payloads to 16kHz mono WAV for
# whisper.cpp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# Pull in the whisper.cpp binary + tiny.en model. Server code shells out
# to /opt/whisper/whisper-cli, see server/whisper.ts.
COPY --from=whisper-builder /build/whisper.cpp/build/bin/whisper-cli /opt/whisper/whisper-cli
COPY --from=whisper-builder /build/whisper.cpp/models/ggml-tiny.en.bin /opt/whisper/ggml-tiny.en.bin
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
COPY convex ./convex
COPY scripts ./scripts
EXPOSE 3456
CMD ["npx", "tsx", "server/index.ts"]
