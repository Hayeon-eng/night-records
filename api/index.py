"""Vercel 서버리스 진입점. server.py 의 WSGI 애플리케이션을 `app` 으로 노출한다."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import application as app  # noqa: E402,F401
