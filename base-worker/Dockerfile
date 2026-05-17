FROM python:3.11-slim

WORKDIR /workspace

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ ./src/

# Copy crontab and entrypoint
COPY crontab /workspace/crontab
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Install cron and make entrypoint executable
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron \
    && rm -rf /var/lib/apt/lists/* \
    && chmod +x /docker-entrypoint.sh

# Run as non-root. cron in the entrypoint stays under this UID — if the
# deployer needs system-wide cron they must override the entrypoint.
RUN groupadd -r worker && useradd -r -g worker -d /workspace -s /bin/sh worker \
    && chown -R worker:worker /workspace
USER worker

# Default env - can be overridden at runtime
ENV LLM_PROVIDER=openai
ENV TICKET_ID=undefined
ENV ROLE=default

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "src/index.py"]