"""Reintentos breves cuando el proveedor de IA está saturado."""
import random
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# 503/529 significan que el proveedor rechazó la consulta sin generarla, así que repetirla es seguro.
# 429 (cuota) y los tiempos de espera no se repiten: podrían gastar cuota o duplicar una consulta facturada.
PROVIDER_BUSY_CODES = (503, 529)
BACKOFF_SECONDS = (1.5, 4.0)
MAX_RETRY_AFTER_SECONDS = 8.0


def _wait_seconds(error: HTTPError, attempt: int) -> float:
    try:
        requested = float(error.headers.get('Retry-After', ''))
    except (TypeError, ValueError, AttributeError):
        requested = 0.0
    return min(max(requested, BACKOFF_SECONDS[attempt]), MAX_RETRY_AFTER_SECONDS) + random.uniform(0, 0.4)


def urlopen_with_retry(request: Request, timeout: float):
    for attempt in range(len(BACKOFF_SECONDS) + 1):
        try:
            return urlopen(request, timeout=timeout)
        except HTTPError as error:
            if error.code not in PROVIDER_BUSY_CODES or attempt == len(BACKOFF_SECONDS):
                raise
            wait = _wait_seconds(error, attempt)
            error.close()
            time.sleep(wait)
