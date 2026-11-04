// ============================================================================
// fixture-csharp-orders — sipariş kalıcılığı (bellek-içi repository).
//
// Kanıt zincirinin ucu: OrderRepository.Save / GetAll (TŞ v2.1 §25/4'teki
// "POST /orders → service → repository" zincirinin son halkası).
// ============================================================================

using System.Collections.Generic;

namespace Causoryn.Fixture.Orders.Repositories;

/// <summary>Sipariş kaydının alan sözleşmesi.</summary>
public record Order
{
    public required string Id { get; init; }

    public required string Sku { get; init; }

    public required int Quantity { get; init; }
}

/// <summary>Siparişleri bellek-içi tutan sahte repository.</summary>
public class OrderRepository
{
    private readonly List<Order> _orders = new();

    public Order Save(Order order)
    {
        _orders.Add(order);
        return order;
    }

    public Order? Find(string id)
    {
        foreach (var order in _orders)
        {
            if (order.Id == id)
            {
                return order;
            }
        }

        return null;
    }

    public Order[] GetAll()
    {
        return _orders.ToArray();
    }
}
