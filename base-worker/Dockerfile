FROM python:3.11-slim

WORKDIR /workspace

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ ./src/

# Default env - can be overridden at runtime
ENV LLM_PROVIDER=openai
ENV TICKET_ID=undefined
ENV ROLE=default

CMD ["python", "src/index.py"]