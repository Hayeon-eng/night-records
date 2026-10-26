FROM python:3.12-slim
WORKDIR /app
COPY requirements-production.txt .
RUN pip install --no-cache-dir -r requirements-production.txt
RUN useradd --create-home game && mkdir -p /app/data && chown game:game /app/data
COPY --chown=game:game engine.py server.py scenario.py ./
COPY --chown=game:game static ./static
USER game
ENV DB_PATH=/app/data/game.sqlite3
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "8", "server:application"]

