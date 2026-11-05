// ============================================================================
// fixture-csharp-orders — giriş dosyası (top-level statements).
//
// Bu fixture, TŞ v2.1 §25/4 kanıt zincirinin C# karşılığını taşır:
//   POST /orders (controller) → OrdersService.Create → OrderRepository.Save
// Ayrıca minimal API örneği: GET /health → Program.Health (ROUTES_TO).
//
// WebApplication.AddScoped/AddControllers gibi DI kayıt çağrıları çağıran
// bağlamı (top-level statement) modellenmediği için CALLS üretmez; bu
// bilinçli kapsamı PROTOCOL.md "unsupportedConstructs" bölümünde belgelenir.
// ============================================================================

using Causoryn.Fixture.Orders.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<OrdersService>();
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.MapGet("/health", Health);
app.Run();

// Minimal API handler'ı adlandırılmış yerel fonksiyondur: inline/anonymous
// lambda handler'lar unsupportedConstructs kapsamındadır (uydurma kenar
// üretilmez), adlandırılmış sembol semantic model ile çözümlenir.
static string Health() => "ok";
