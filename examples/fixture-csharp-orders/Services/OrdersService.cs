// ============================================================================
// fixture-csharp-orders — sipariş servis katmanı.
//
// Kanıt zincirinin ortası: OrdersService.Create → OrderRepository.Save
// CALLS kenarı semantic model kanıtıyla (semantic-symbol) üretilir
// (TŞ v2.1 §25/4 zinciri).
// ============================================================================

using Causoryn.Fixture.Orders.Repositories;

namespace Causoryn.Fixture.Orders.Services;

/// <summary>Yeni sipariş oluşturma girdisi.</summary>
public record CreateOrderInput
{
    public required string Sku { get; init; }

    public required int Quantity { get; init; }
}

/// <summary>Sipariş iş kurallarını taşıyan servis.</summary>
public class OrdersService
{
    private readonly OrderRepository _repository;

    public OrdersService(OrderRepository repository)
    {
        _repository = repository;
    }

    public Order Create(CreateOrderInput input)
    {
        var order = new Order
        {
            Id = $"order-{input.Sku}-{input.Quantity}",
            Sku = input.Sku,
            Quantity = input.Quantity,
        };
        return _repository.Save(order);
    }

    public Order? GetById(string id)
    {
        foreach (var candidate in _repository.GetAll())
        {
            if (candidate.Id == id)
            {
                return candidate;
            }
        }

        return null;
    }
}
