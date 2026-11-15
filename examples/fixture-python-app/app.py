# ===========================================================================
# fixture-python-app — HTTP katmanı (FastAPI tarzı dekoratör rotaları).
#
# Route kanıtı: @app.get/@app.post dekoratör kalıpları worker'da Endpoint
# node'u ("GET /orders", "POST /orders") + Endpoint → handler ROUTES_TO
# kenarı üretir (TŞ v2.1 §7: Python AST + framework rules, seçili L3).
# Çağrı kanıtı: handler'lar services modülünden import edilen sembollere
# CALLS üretir — import edilen sembol heuristic'tir (tam type inference
# yok — dürüst sınırlama, PROTOCOL.md resolution tablosu).
# Çözümsüz kanıt: get_orders içindeki logger.info tanımlı/import edilmiş
# olmadığı için unresolved UnknownExternal hedefle raporlanır.
# ===========================================================================
from fastapi import FastAPI

from services.orders_service import create_order, list_orders

app = FastAPI()


@app.get("/orders")
def get_orders():
    logger.info("siparişler sorgulandı")  # çözümsüz: logger set içinde yok
    return list_orders()


@app.post("/orders")
def add_order(order):
    return create_order(order)
