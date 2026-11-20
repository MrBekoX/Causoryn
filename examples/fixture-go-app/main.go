// ============================================================================
// fixture-go-app — giriş dosyası (package main).
//
// TŞ v2.1 §25/4 kanıt zincirinin Go karşılığı:
//   "* /orders" (http.HandleFunc) → ordersHandler → newOrderService (verified)
//     → services.NewOrdersService (heuristic) → repositories.NewOrdersRepository
//   ordersHandler → services.OrdersService.GetOrders (benzersiz metot adı,
//     heuristic) → repositories.OrdersRepository.FindAll
//   "* /orders/create" → createOrderHandler → services.OrdersService.Create
//     → repositories.OrdersRepository.Save
//   "* /health" → healthHandler → writeJSON
//
// Aynı-package bare-ident çağrılar (newOrderService, writeJSON) verified;
// package-qualified çağrılar (services./repositories./http./log.) heuristic;
// selector-call ifadeleri (w.Header().Set, json.NewEncoder(w).Encode)
// çözümsüzdür (unresolved) — go/types semantik çözümleme bu dilimde yoktur
// (native/go-worker/PROTOCOL.md resolution tablosu).
// ============================================================================
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"causoryn.fixture.go-orders/repositories"
	"causoryn.fixture.go-orders/services"
)

// newOrderService handler→service→repository zincirini kurar.
func newOrderService() *services.OrdersService {
	return services.NewOrdersService(repositories.NewOrdersRepository())
}

// ordersHandler "/orders" isteklerini karşılar.
func ordersHandler(w http.ResponseWriter, _ *http.Request) {
	svc := newOrderService()
	writeJSON(w, svc.GetOrders())
}

// createOrderHandler "/orders/create" isteklerini karşılar.
func createOrderHandler(w http.ResponseWriter, _ *http.Request) {
	svc := newOrderService()
	writeJSON(w, svc.Create("fixture-sku", 2))
}

// writeJSON payload'ı JSON olarak yazar.
func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

// healthHandler "/health" isteklerini karşılar.
func healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]string{"status": "ok"})
}

func main() {
	http.HandleFunc("/orders", ordersHandler)
	http.HandleFunc("/orders/create", createOrderHandler)
	http.HandleFunc("/health", healthHandler)
	// Sunucu kaynak sınırları (güvenlik kuralı): okuma/yazma zaman aşımları
	// açık bir http.Server ile tanımlanır.
	srv := &http.Server{
		Addr:              ":8080",
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
