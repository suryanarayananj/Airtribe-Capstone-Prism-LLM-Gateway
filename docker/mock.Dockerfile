# Pack mock OpenAI-compatible provider (scripts/mock_provider.py — stdlib only)
FROM python:3.12-slim

WORKDIR /app
COPY scripts/mock_provider.py ./mock_provider.py

ENV PYTHONUNBUFFERED=1
EXPOSE 9001

ENTRYPOINT ["python", "mock_provider.py"]
CMD ["--port", "9001", "--name", "alpha"]
