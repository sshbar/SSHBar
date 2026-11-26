# Linux runner for the README screenshots (scripts/demo-linux.sh builds and runs it).
# Electron's runtime libraries, a virtual X display (headless mode has no GPU to capture from), ffmpeg
# for the GIFs, and the fonts a Linux desktop would have.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
      libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxtst6 \
      xvfb xauth ffmpeg ca-certificates fonts-cantarell fonts-jetbrains-mono fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# system-ui / sans-serif -> Cantarell (GNOME's UI font), monospace -> JetBrains Mono
RUN printf '%s\n' '<?xml version="1.0"?>' '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' '<fontconfig>' \
      '<alias><family>sans-serif</family><prefer><family>Cantarell</family></prefer></alias>' \
      '<alias><family>system-ui</family><prefer><family>Cantarell</family></prefer></alias>' \
      '<alias><family>monospace</family><prefer><family>JetBrains Mono</family></prefer></alias>' \
      '</fontconfig>' > /etc/fonts/local.conf && fc-cache -f

WORKDIR /app
COPY package.json package-lock.json ./
# includes Electron's own install step, which downloads its Linux binary
RUN npm ci --no-audit --no-fund
