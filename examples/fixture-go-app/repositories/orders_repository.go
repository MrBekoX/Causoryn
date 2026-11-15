// ============================================================================
// fixture-go-app — sipariş kalıcılığı (package repositories).
//
// Zincirin ucu: OrdersRepository.FindAll / Save — TŞ v2.1 §25/4'teki
// "route → service → repository" zincirinin son halkası.
// ============================================================================
package repositories

// Order sipariş kaydının alan sözleşmesidir.
type Order struct {
	ID       string
	SKU      string
	Quantity int
}

// OrdersRepository siparişleri bellek-içi tutar.
type OrdersRepository struct {
	orders []Order
}

// NewOrdersRepository boş repository kurar.
func NewOrdersRepository() *OrdersRepository {
	return &OrdersRepository{orders: make([]Order, 0)}
}

// FindAll tüm siparişleri döner.
func (r *OrdersRepository) FindAll() []Order {
	return r.orders
}

// Save siparişi kaydeder.
func (r *OrdersRepository) Save(order Order) Order {
	r.orders = append(r.orders, order)
	return order
}
