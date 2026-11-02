/**
 * fixture-ts-orders — minimal, framework-bağımsız HTTP router.
 *
 * Causoryn TS adapter'ının (Sprint-1 görev 4) route tespiti bu kalıbı
 * tanır: `<router>.post("/path", handler)` çağrı ifadesi Endpoint node'u +
 * ROUTES_TO kenarı üretir (TŞ v2.1 §7 "framework-agnostic minimal",
 * §25/4 kanıt zinciri).
 */

/** Route handler'ın okuduğu istek gövdesi taşıyıcısı. */
export interface Request<TBody = unknown> {
  readonly body: TBody;
}

/** Route handler'ın yanıt yazdığı minimal arayüz. */
export interface Response {
  json(payload: unknown): void;
}

/**
 * Handler imzası; `RouteHandler<TBody>` tipi app.ts'teki factory dönüş
 * tipini buradan alır. Call signature'lı tipler adapter'da Handler
 * node'una eşlenir.
 */
export type RouteHandler<TBody = unknown> = (
  request: Request<TBody>,
  response: Response,
) => void;

/** HTTP fiili + handler eşlemesini tutan minimal router. */
export class Router {
  private readonly registeredPaths: string[] = [];

  post<TBody>(path: string, handler: RouteHandler<TBody>): void {
    this.registeredPaths.push(path);
    void handler;
  }
}
