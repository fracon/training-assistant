FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GARMIN_STORE=/var/lib/kinesis-garmin
WORKDIR /app
COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && groupadd --system --gid 10001 connector \
    && useradd --system --uid 10001 --gid connector --home-dir /nonexistent connector \
    && mkdir -p /var/lib/kinesis-garmin \
    && chown -R connector:connector /app /var/lib/kinesis-garmin \
    && chmod 0700 /var/lib/kinesis-garmin
COPY --chown=connector:connector app ./app
LABEL org.opencontainers.image.version="0.25.0" \
      org.opencontainers.image.title="Kinesis private Garmin connector"
USER 10001:10001
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
