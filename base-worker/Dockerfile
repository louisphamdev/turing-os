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

# Default env - can be overridden at runtime
ENV LLM_PROVIDER=openai
ENV TICKET_ID=undefined
ENV ROLE=default

# Use custom entrypoint that runs cron + main process
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "src/index.py"]