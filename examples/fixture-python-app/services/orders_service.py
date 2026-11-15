# ===========================================================================
# fixture-python-app — servis katmanı.
#
# create_order: _validate_order çağrısı AYNI modülde tanımlı → verified
# (AST isim bağlamı); save çağrısı import edilen modül sembolü → heuristic
# (tam type inference YOK — dürüst sınırlama, PROTOCOL.md resolution kuralı).
# Zincir: app.add_order (route) → create_order → save (repository).
# audit_order: async def bildirimi — Function node kanıtı.
# ===========================================================================
from repositories.order_repository import all_orders, save


def _validate_order(order):
    if not isinstance(order, dict):
        raise ValueError("order bir sözlük olmalı")
    return True


def create_order(order):
    _validate_order(order)
    return save(order)


def list_orders():
    return all_orders()


async def audit_order(order):
    return {"audited": True, "order": order}
