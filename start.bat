@echo off
.venv\Scripts\python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
