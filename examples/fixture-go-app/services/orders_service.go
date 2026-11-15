// ============================================================================
// fixture-go-app — sipariş servis katmanı (package services).
//
// Zincirin ortası: OrdersService.GetOrders → repositories.OrdersRepository.FindAll
// ve OrdersService.Create → repositories.OrdersRepository.Save CALLS kenarları
// benzersiz metot adı kuralıyla (heuristic — go/types yok) üretilir.
// ============================================================================
package services

import "causoryn.fixture.go-orders/repositories"

// OrdersService sipariş iş kurallarını taşır.
type OrdersService struct {
	repo *repositories.OrdersRepository
}

// NewOrdersService yeni servis kurar (package-qualified çağrı hedefi).
func NewOrdersService(repo *repositories.OrdersRepository) *OrdersService {
	return &OrdersService{repo: repo}
}

// GetOrders tüm siparişleri döner.
func (s *OrdersService) GetOrders() []repositories.Order {
	return s.repo.FindAll()
}

// Create yeni sipariş oluşturur.
func (s *OrdersService) Create(sku string, quantity int) repositories.Order {
	order := repositories.Order{ID: "order-" + sku, SKU: sku, Quantity: quantity}
	return s.repo.Save(order)
}
