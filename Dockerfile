FROM python:3.12-slim

LABEL org.opencontainers.image.source="https://github.com/JacobRuter/FinanceTracker"
LABEL org.opencontainers.image.description="Self-hosted personal finance tracker for Chase and Capital One statements"

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ .

ENV DB_PATH=/data/finance.db
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/months')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
