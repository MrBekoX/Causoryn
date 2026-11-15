# ===========================================================================
# fixture-python-app — repository katmanı.
#
# save: zincirin ucu (services.orders_service.create_order → save).
# OrderRepository sınıfı: Method node + sınıf içi verified çağrı kanıtı —
# OrderRepository.save gövdesindeki 'save' adı modül düzeyi fonksiyona
# (verified), self._stamp sarmalayan sınıfın üye tablosuna çözümlenir.
# ===========================================================================
_ORDERS = {}
_SEQ = {"value": 0}


def save(order):
    if "id" not in order:
        _SEQ["value"] = _SEQ["value"] + 1
        order["id"] = _SEQ["value"]
    _ORDERS[order["id"]] = order
    return order


def all_orders():
    return list(_ORDERS.values())


class OrderRepository:
    def save(self, order):
        return save(self._stamp(order))

    def _stamp(self, order):
        order["stamped"] = True
        return order
