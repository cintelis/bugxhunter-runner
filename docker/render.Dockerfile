# BugXHunter render service: turns diagram specs written by models into editable
# .drawio.svg files with drawgen (https://github.com/cintelis/drawio-tools).
#
# Kept out of the runner on purpose: the runner holds the vault key in memory, and
# model output is parsed here instead, in a container with no internet (an internal
# network only the runner shares), no volumes, no secrets and a read-only filesystem.
# drawgen's built-in renderer needs only the standard library and PyYAML, so no
# draw.io Desktop or browser is installed.
FROM python:3.12-slim

# drawgen is pinned to a release wheel and checked against its published SHA-256.
ARG DRAWGEN_VERSION=0.2.0
ARG DRAWGEN_SHA256=8787f49e8e8700705d6ae9beeb188fad05c8a1ea6a8569497d2f69ab47571888
RUN printf 'drawgen @ https://github.com/cintelis/drawio-tools/releases/download/v%s/drawgen-%s-py3-none-any.whl --hash=sha256:%s\n' \
        "$DRAWGEN_VERSION" "$DRAWGEN_VERSION" "$DRAWGEN_SHA256" > /tmp/req.txt \
    && pip install --no-cache-dir --no-deps --require-hashes -r /tmp/req.txt \
    && pip install --no-cache-dir pyyaml==6.0.3 \
    && rm /tmp/req.txt

WORKDIR /app
COPY docker/render-server.py /app/render-server.py
COPY docker/drawio_outline.py /app/drawio_outline.py
USER nobody
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RENDER_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"
CMD ["python", "-I", "/app/render-server.py"]
