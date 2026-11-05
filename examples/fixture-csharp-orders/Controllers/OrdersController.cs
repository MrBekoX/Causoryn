// ============================================================================
// fixture-csharp-orders — ASP.NET Core controller katmanı.
//
// Route kanıtı: [Route("api/[controller]")] sınıf kalıbı + [HttpGet]/[HttpPost]
// metot kalıpları worker'da Endpoint node'u ("GET /api/orders/{id}" ve
// "POST /api/orders") + Endpoint → action ROUTES_TO kenarı üretir
// (TŞ v2.1 §7: controller/minimal API L3).
// ============================================================================

using Causoryn.Fixture.Orders.Repositories;
using Causoryn.Fixture.Orders.Services;
using Microsoft.AspNetCore.Mvc;

namespace Causoryn.Fixture.Orders.Controllers;

/// <summary>Sipariş HTTP API'si — kanıt zincirinin başlangıcı.</summary>
[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    private readonly OrdersService _ordersService;

    public OrdersController(OrdersService ordersService)
    {
        _ordersService = ordersService;
    }

    /// <summary>GET api/orders/{id} — sipariş sorgulama.</summary>
    [HttpGet("{id}")]
    public Order? GetById(string id)
    {
        return _ordersService.GetById(id);
    }

    /// <summary>POST api/orders — sipariş oluşturma.</summary>
    [HttpPost]
    public Order Create([FromBody] CreateOrderInput input)
    {
        return _ordersService.Create(input);
    }
}
